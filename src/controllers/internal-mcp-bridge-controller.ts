import { createHash } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { agentGateway, isMcpToolResultEnvelope } from '../agent/ws-server.js';
import { type VerifiedRunScopeClaims } from '../services/token-service.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, WorkflowRunRecord } from '../store/repository-workflows.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { AgentToolCallError, AgentUnavailableError } from '../agent/types.js';
import { getWorkspaceNativeTool } from '../services/workspace-native-tools.js';
import {
  executeWorkspaceNativeTool,
  WorkspaceNativeToolExecutionError
} from '../services/workspace-native-tool-executor.js';
import {
  executeAgentTargetsMcpTool,
  AgentTargetsMcpExecutionError
} from '../services/agent-targets-mcp-executor.js';
import {
  isAgentTargetsMcpInstallation,
  isAgentTargetsMcpToolName
} from '../services/agent-targets-mcp-catalog.js';
import { config } from '../config.js';

const ACTIVE_TOOL_RUN_STATUSES = new Set(['dispatching', 'running', 'waiting_for_approval']);

export function normalizeTargetAgentToolResult(result: unknown, targetType: string): Record<string, unknown> {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const hasMcpContent = isMcpToolResultEnvelope(value);
  const structured = value?.structuredContent && typeof value.structuredContent === 'object'
    ? value.structuredContent as Record<string, unknown>
    : null;
  const hasStructuredContent = structured?.schemaVersion === 'acornops.full-tool-result.v1'
    && Object.prototype.hasOwnProperty.call(structured, 'data');
  if (!hasMcpContent || !hasStructuredContent) throw new Error(`${targetType === KUBERNETES_TARGET_TYPE ? 'AgentK' : 'AgentV'} returned an invalid MCP tool result`);
  return value!;
}

export function stableAgentRequestId(runId: string, toolCallId: unknown): string | undefined {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;
  return `tool_${createHash('sha256').update(`${runId}:${toolCallId}`).digest('hex')}`;
}

export function publicAgentToolError(err: unknown): Record<string, unknown> {
  if (err instanceof AgentUnavailableError) {
    return {
      code: 'TARGET_AGENT_UNAVAILABLE',
      message: err.message,
      outcome: 'not_started'
    };
  }
  if (!(err instanceof AgentToolCallError) || typeof err.data?.code !== 'string') {
    return { code: 'AGENT_TOOL_ERROR', message: 'Agent tool call failed' };
  }
  return {
    code: err.data.code,
    message: err.message,
    ...(err.data?.outcome === 'unknown' ? { outcome: 'unknown' } : {}),
    ...(typeof err.data?.operationId === 'string' ? { operationId: err.data.operationId } : {}),
  };
}

function isToolAllowedByRunToken(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes('*') || allowedTools.includes(toolName);
}

export function operationForToolCall(claims: Pick<VerifiedRunScopeClaims, 'allowedToolOperations'>, toolName: string): 'read' | 'write' {
  return claims.allowedToolOperations?.[toolName] === 'read' ? 'read' : 'write';
}

function operationForWorkflowToolCall(run: WorkflowRunRecord, toolName: string): 'read' | 'write' {
  return run.compiledAccessScope.toolOperations[toolName] === 'write' ? 'write' : 'read';
}

export async function callMcpTool(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const claims = res.locals.gatewayRunClaims as VerifiedRunScopeClaims | undefined;
    if (!claims) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Run token required', retryable: false } });
      return;
    }
    const toolName = String(req.body?.name || '');
    const args = (req.body?.arguments || {}) as Record<string, unknown>;
    if (!toolName) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required', retryable: false } });
      return;
    }

    const requestedToolRef = req.body?.toolRef && typeof req.body.toolRef === 'object'
      ? req.body.toolRef as { server_id?: string; tool_name?: string }
      : undefined;
    const requestedRefAllowed = requestedToolRef
      ? claims.allowedToolRefs?.some((ref) => (
          ref.serverId === requestedToolRef.server_id && ref.toolName === requestedToolRef.tool_name
        )) === true
      : false;
    if (requestedToolRef && (!requestedRefAllowed || requestedToolRef.tool_name !== toolName)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this run', retryable: false } });
      return;
    }
    const workspaceId = claims.workspaceId;
    const targetId = claims.targetId;
    const targetType = claims.targetType;
    const workflowRun = await getWorkflowRun(claims.runId);
    const run = workflowRun ? null : await repo.getRun(claims.runId);
    if (!workflowRun && !run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const scopeMatches = workflowRun
      ? claims.scopeType === 'workspace'
        && workflowRun.workspaceId === workspaceId && workflowRun.workflowSessionId === claims.sessionId
        && workflowRun.executionId === claims.executionId
        && workflowRun.executorRole === claims.executorRole
        && (workflowRun.executorRole === 'coordinator'
          ? !claims.agentId
          : workflowRun.agentId === claims.agentId)
      : run?.conversationKind === 'agent_chat'
        ? claims.scopeType === 'agent_chat'
          && run.workspaceId === workspaceId && run.sessionId === claims.sessionId
          && run.agentId === claims.agentId
        : run
          ? claims.scopeType === 'target'
            && run.workspaceId === workspaceId && run.targetId === targetId && run.targetType === targetType && run.sessionId === claims.sessionId
        : false;
    if (!scopeMatches) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Run token scope does not match run', retryable: false } });
      return;
    }
    const agentSnapshot = workflowRun?.executorSnapshot.role === 'specialist'
      && workflowRun.executorSnapshot.agentId === claims.agentId
      ? workflowRun.executorSnapshot.agent
      : run?.conversationKind === 'agent_chat' && run.agentId === claims.agentId
        ? run.agentSnapshot
        : undefined;
    const agentTargetsInstallation = requestedToolRef && agentSnapshot
      ? agentSnapshot.mcpInstallations.find((installation) => (
          installation.id === requestedToolRef.server_id
          && isAgentTargetsMcpInstallation(installation, config.BUILTIN_TARGET_MCP_SERVER_URL)
        ))
      : undefined;
    const agentTargetsTool = agentTargetsInstallation?.tools.find((tool) => (
      tool.serverId === requestedToolRef?.server_id && tool.toolName === toolName
    ));
    const authorizedToolName = agentTargetsTool?.alias || toolName;
    if (!isToolAllowedByRunToken(authorizedToolName, claims.allowedTools)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this run', retryable: false } });
      return;
    }
    if (workflowRun && !workflowRun.compiledAccessScope.tools.includes(authorizedToolName)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this workflow run', retryable: false } });
      return;
    }
    if (run?.conversationKind === 'agent_chat' && !run.compiledAccessScope?.tools.includes(authorizedToolName)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this Agent chat run', retryable: false } });
      return;
    }
    if (!ACTIVE_TOOL_RUN_STATUSES.has(workflowRun?.status || run!.status)) {
      res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for tool execution', retryable: false } });
      return;
    }
    if (agentTargetsInstallation) {
      if (!agentTargetsTool
        || !isAgentTargetsMcpToolName(toolName)
        || !agentTargetsInstallation.enabled
        || !agentTargetsTool.enabled
        || agentTargetsTool.reviewState !== 'approved'
        || agentTargetsTool.capability !== 'read') {
        res.status(403).json({ error: {
          code: 'AGENT_TARGETS_MCP_SCOPE_DENIED',
          message: 'The Targets MCP tool is outside the pinned Agent capability snapshot.',
          retryable: false
        } });
        return;
      }
      const startedAt = Date.now();
      try {
        const result = await executeAgentTargetsMcpTool({
          workspaceId,
          toolName,
          arguments: args,
          targetAccessPolicy: agentSnapshot!.targetAccessPolicy
        });
        await recordWorkspaceAuditEvent({
          workspaceId,
          category: 'tool',
          eventType: 'tool.called.v1',
          operation: 'read',
          actorType: 'system',
          objectType: 'tool_call',
          objectId: `${agentSnapshot!.id}:${toolName}:${startedAt}`,
          objectName: toolName,
          summary: 'Built-in Agent Targets MCP tool called',
          metadata: {
            agentId: agentSnapshot!.id,
            serverId: agentTargetsInstallation.id,
            toolName,
            source: 'builtin_agent_targets_mcp',
            runId: claims.runId,
            durationMs: Date.now() - startedAt,
            isError: false
          }
        });
        res.status(200).json(result);
      } catch (error) {
        if (error instanceof AgentTargetsMcpExecutionError) {
          res.status(error.status).json({ error: {
            code: error.code,
            message: error.message,
            retryable: false,
            outcome: 'not_started'
          } });
          return;
        }
        throw error;
      }
      return;
    }
    const workspaceNativeTool = getWorkspaceNativeTool(toolName);
    if (workspaceNativeTool) {
      const nativeRun = workflowRun || run;
      const invocationScopeAllowed = workflowRun
        ? workspaceNativeTool.invocationScopes.includes('workflow')
        : run?.conversationKind === 'agent_chat'
          ? workspaceNativeTool.invocationScopes.includes('agent_chat')
          : workspaceNativeTool.invocationScopes.includes('target_chat');
      if (!nativeRun || !invocationScopeAllowed) {
        res.status(403).json({ error: {
          code: 'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED',
          message: 'The native tool is not available in this run scope.',
          retryable: false
        } });
        return;
      }
      try {
        const result = await executeWorkspaceNativeTool({
          run: nativeRun,
          toolId: toolName,
          toolCallId: typeof req.body.toolCallId === 'string' ? req.body.toolCallId : '',
          arguments: args
        });
        res.status(200).json(result);
      } catch (error) {
        if (error instanceof WorkspaceNativeToolExecutionError) {
          res.status(error.status).json({ error: { code: error.code, message: error.message, retryable: false } });
          return;
        }
        throw error;
      }
      return;
    }
    if (targetType !== KUBERNETES_TARGET_TYPE && targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
      res.status(400).json({
        error: { code: 'UNSUPPORTED_TARGET_TYPE', message: 'Built-in tools require a supported target type', retryable: false }
      });
      return;
    }
    const boundTargetId = targetId!;
    const target = await repo.getTarget(workspaceId, boundTargetId);
    if (!target || target.targetType !== targetType) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
      return;
    }

    const startedAt = Date.now();
    const operation = workflowRun
      ? operationForWorkflowToolCall(workflowRun, authorizedToolName)
      : operationForToolCall(claims, toolName);
    try {
      const agentResult = await agentGateway.callAgentMcpTool(
        boundTargetId,
        toolName,
        args,
        stableAgentRequestId(claims.runId, req.body.toolCallId)
      );
      const result = normalizeTargetAgentToolResult(agentResult, targetType);
      const isError = (result as { isError?: unknown }).isError === true;
      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        clusterId: targetType === KUBERNETES_TARGET_TYPE ? targetId : undefined,
        targetId,
        targetType,
        subject: { type: 'tool_call', id: `${targetId}:${toolName}:${Date.now()}` },
        data: {
          toolName,
          source: 'builtin_mcp_bridge',
          runId: claims.runId,
          ...(workflowRun ? {
            workflowId: workflowRun.workflowId,
            executionId: workflowRun.executionId,
            executorRole: workflowRun.executorRole,
            workflowSessionId: workflowRun.workflowSessionId,
          } : {}),
          durationMs: Date.now() - startedAt,
          isError
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation,
        actorType: 'system',
        objectType: 'tool_call',
        objectId: `${targetId}:${toolName}:${startedAt}`,
        objectName: toolName,
        summary: 'Built-in MCP tool called',
        metadata: {
          targetId,
          targetType,
          toolName,
          source: 'builtin_mcp_bridge',
          runId: claims.runId,
          ...(workflowRun ? {
            workflowId: workflowRun.workflowId,
            executionId: workflowRun.executionId,
            executorRole: workflowRun.executorRole,
            workflowSessionId: workflowRun.workflowSessionId,
          } : {}),
          durationMs: Date.now() - startedAt,
          isError
        }
      });
      res.status(200).json(result);
      return;
    } catch (err) {
      const publicError = publicAgentToolError(err);
      const message = String(publicError.message);
      webhooks.emit({
        type: 'tool.called.v1',
        workspaceId,
        clusterId: targetType === KUBERNETES_TARGET_TYPE ? targetId : undefined,
        targetId,
        targetType,
        subject: { type: 'tool_call', id: `${targetId}:${toolName}:${Date.now()}` },
        data: {
          toolName,
          source: 'builtin_mcp_bridge',
          runId: claims.runId,
          durationMs: Date.now() - startedAt,
          isError: true,
          error: message
        }
      });
      await recordWorkspaceAuditEvent({
        workspaceId,
        category: 'tool',
        eventType: 'tool.called.v1',
        operation,
        actorType: 'system',
        objectType: 'tool_call',
        objectId: `${targetId}:${toolName}:${startedAt}`,
        objectName: toolName,
        summary: 'Built-in MCP tool call failed',
        metadata: {
          targetId,
          targetType,
          toolName,
          source: 'builtin_mcp_bridge',
          runId: claims.runId,
          durationMs: Date.now() - startedAt,
          isError: true
        }
      });
      const unavailable = publicError.code === 'TARGET_AGENT_UNAVAILABLE';
      res.status(unavailable ? 503 : 502).json({
        error: {
          ...publicError,
          retryable: unavailable || publicError.code === 'TOOL_TIMEOUT' || publicError.code === 'AGENT_TOOL_ERROR'
        }
      });
      return;
    }
  } catch (err) {
    next(err);
  }
}
