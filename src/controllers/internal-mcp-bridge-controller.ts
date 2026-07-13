import { createHash } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { agentGateway } from '../agent/ws-server.js';
import { type VerifiedRunScopeClaims } from '../services/token-service.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, WorkflowRunRecord } from '../store/repository-workflows.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { AgentToolCallError } from '../agent/types.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import { db } from '../infra/db.js';
import { createWorkflowReport } from '../store/repository-workflow-reports.js';

const ACTIVE_TOOL_RUN_STATUSES = new Set(['dispatching', 'running', 'waiting_for_approval']);

export function stableAgentRequestId(runId: string, toolCallId: unknown): string | undefined {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;
  return `tool_${createHash('sha256').update(`${runId}:${toolCallId}`).digest('hex')}`;
}

export function publicAgentToolError(err: unknown): Record<string, unknown> {
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

function isWorkflowScopeClaimMatch(run: WorkflowRunRecord, claims: VerifiedRunScopeClaims): boolean {
  return claims.scopeType === 'workspace'
    && claims.workspaceId === run.workspaceId
    && claims.sessionId === run.workflowSessionId
    && claims.workflowId === run.workflowId
    && claims.workflowRunId === run.workflowRunId
    && claims.workflowSessionId === run.workflowSessionId
    && (!run.workflowStepId || claims.workflowStepId === run.workflowStepId);
}

async function executeWorkflowTool(run: WorkflowRunRecord, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (toolName === 'mcp.servers.list') {
    return {
      scopeType: 'workspace',
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      mcpServers: run.compiledAccessScope.mcpServers
    };
  }
  if (toolName === 'mcp.tools.list') {
    return {
      scopeType: 'workspace',
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      tools: run.compiledAccessScope.tools,
      toolOperations: run.compiledAccessScope.toolOperations
    };
  }
  if (toolName === 'roles.permissions.read') {
    return {
      scopeType: 'workspace',
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      actor: run.compiledAccessScope.actor,
      grantedCapabilities: run.compiledAccessScope.grantedCapabilities,
      requiredPermissions: run.compiledAccessScope.requiredPermissions
    };
  }
  if (toolName === 'audit.events.search') {
    if (!run.compiledAccessScope.contextGrants.includes('audit_events')) {
      return {
        scopeType: 'workspace',
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        events: [],
        warning: 'audit_events context grant is not available for this workflow run'
      };
    }
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(50, Math.trunc(args.limit)))
      : 25;
    const page = await repo.listWorkspaceAuditEvents(run.workspaceId, { limit });
    return {
      scopeType: 'workspace',
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      events: page.items
    };
  }
  if (toolName === 'chat.sessions.read_selected') {
    if (!run.compiledAccessScope.contextGrants.includes('selected_chat_sessions')) {
      throw new Error('SELECTED_CHAT_CONTEXT_NOT_GRANTED');
    }
    const executionResult = await db.query<QueryResultRow>('SELECT input_context FROM workflow_executions WHERE id=$1', [run.executionId]);
    const grantedIds = new Set<string>(executionResult.rows[0]?.input_context?.chatSessionIds || []);
    const requestedIds = Array.isArray(args.sessionIds)
      ? args.sessionIds.filter((id): id is string => typeof id === 'string')
      : [...grantedIds];
    if (!requestedIds.length || requestedIds.some((id) => !grantedIds.has(id))) throw new Error('CHAT_SESSION_NOT_EXPLICITLY_GRANTED');
    const sessions = await db.query<QueryResultRow>(
      `SELECT id,title FROM sessions WHERE workspace_id=$1 AND id=ANY($2::text[])
       AND deleted_at IS NULL AND expires_at>NOW()`, [run.workspaceId, requestedIds]
    );
    if (sessions.rows.length !== requestedIds.length) throw new Error('CHAT_SESSION_UNAVAILABLE');
    const messages = await db.query<QueryResultRow>(
      `SELECT message.session_id,message.role,message.content,message.created_at FROM messages message
       JOIN sessions session ON session.id=message.session_id
       WHERE session.workspace_id=$1 AND message.session_id=ANY($2::text[])
       ORDER BY message.session_id,message.created_at,message.id`, [run.workspaceId, requestedIds]
    );
    return { sessions: sessions.rows.map((session) => ({ id: session.id, title: session.title,
      messages: messages.rows.filter((message) => message.session_id === session.id)
        .map((message) => ({ role: message.role, content: message.content, createdAt: message.created_at })) })) };
  }
  if (toolName === 'reports.pdf.generate') {
    const executionResult = await db.query<QueryResultRow>('SELECT workflow_snapshot,input_context FROM workflow_executions WHERE id=$1', [run.executionId]);
    const execution = executionResult.rows[0];
    const source = args.source && typeof args.source === 'object' && !Array.isArray(args.source)
      ? args.source as Record<string, unknown>
      : { markdown: typeof args.markdown === 'string' ? args.markdown : '' };
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Incident report';
    const report = await createWorkflowReport({
      workspaceId: run.workspaceId, executionId: run.executionId, runId: run.id, title, source,
      provenance: { workflowId: run.workflowId, workflowVersion: execution.workflow_snapshot?.version,
        stepId: run.workflowStepId, agentId: run.agentId, agentVersion: run.agentVersion,
        chatSessionIds: execution.input_context?.chatSessionIds || [] },
      retentionDays: execution.workflow_snapshot?.policy?.retentionDays || 90
    });
    return { artifact: { id: report.id, type: 'pdf', title: report.title,
      mediaType: report.mediaType, downloadPath: `/api/v1/workflow-reports/${report.id}/download` } };
  }
  return {
    scopeType: 'workspace',
    workflowId: run.workflowId,
    workflowRunId: run.workflowRunId,
    tool: toolName,
    message: 'Workflow tool has no built-in executor'
  };
}

async function callWorkflowMcpTool(
  claims: VerifiedRunScopeClaims,
  toolName: string,
  args: Record<string, unknown>,
  res: Response
): Promise<boolean> {
  const run = await getWorkflowRun(claims.runId);
  if (!run) {
    return false;
  }
  if (claims.scopeType !== 'workspace') {
    return false;
  }
  if (!isWorkflowScopeClaimMatch(run, claims)) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Run token scope does not match workflow run', retryable: false } });
    return true;
  }
  if (!ACTIVE_TOOL_RUN_STATUSES.has(run.status)) {
    res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Workflow run is not active for tool execution', retryable: false } });
    return true;
  }
  if (!run.compiledAccessScope.tools.includes(toolName) || !isToolAllowedByRunToken(toolName, claims.allowedTools)) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this workflow run', retryable: false } });
    return true;
  }

  const startedAt = Date.now();
  const operation = operationForWorkflowToolCall(run, toolName);
  const result = await executeWorkflowTool(run, toolName, args);
  await recordWorkspaceAuditEvent({
    workspaceId: run.workspaceId,
    category: 'tool',
    eventType: 'tool.called.v1',
    operation,
    actorType: 'system',
    objectType: 'tool_call',
    objectId: `${run.workflowRunId}:${toolName}:${startedAt}`,
    objectName: toolName,
    summary: 'Workflow MCP tool called',
    metadata: {
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      workflowSessionId: run.workflowSessionId,
      workflowStepId: run.workflowStepId || null,
      toolName,
      source: 'workflow_mcp_bridge',
      runId: run.id,
      durationMs: Date.now() - startedAt,
      isError: false
    }
  });

  res.status(200).json({
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: false
  });
  return true;
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

    if (!isToolAllowedByRunToken(toolName, claims.allowedTools)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this run', retryable: false } });
      return;
    }
    if (await callWorkflowMcpTool(claims, toolName, args, res)) {
      return;
    }
    const workspaceId = claims.workspaceId;
    const targetId = claims.targetId;
    const targetType = claims.targetType;
    if (targetType !== KUBERNETES_TARGET_TYPE && targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
      res.status(400).json({
        error: { code: 'UNSUPPORTED_TARGET_TYPE', message: 'Built-in tools require a supported target type', retryable: false }
      });
      return;
    }
    const boundTargetId = targetId!;
    const workflowRun = await getWorkflowRun(claims.runId);
    const run = workflowRun ? null : await repo.getRun(claims.runId);
    const agentRun = workflowRun || run ? null : await getAgentActivityRecord(claims.runId);
    if (!workflowRun && !run && !agentRun) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const scopeMatches = workflowRun
      ? workflowRun.workspaceId === workspaceId && workflowRun.targetId === targetId
        && workflowRun.targetType === targetType && workflowRun.workflowSessionId === claims.sessionId
      : run
        ? run.workspaceId === workspaceId && run.targetId === targetId && run.targetType === targetType && run.sessionId === claims.sessionId
        : agentRun!.workspaceId === workspaceId && agentRun!.targetId === targetId && agentRun!.targetType === targetType
          && agentRun!.agentId === claims.agentId && agentRun!.agentVersion === claims.agentVersion;
    if (!scopeMatches) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Run token scope does not match run', retryable: false } });
      return;
    }
    if (workflowRun && !workflowRun.compiledAccessScope.tools.includes(toolName)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Tool is not permitted for this workflow run', retryable: false } });
      return;
    }
    if (!ACTIVE_TOOL_RUN_STATUSES.has(workflowRun?.status || run?.status || agentRun!.status)) {
      res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for tool execution', retryable: false } });
      return;
    }
    const target = await repo.getTarget(workspaceId, boundTargetId);
    if (!target || target.targetType !== targetType) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
      return;
    }

    const startedAt = Date.now();
    const operation = workflowRun
      ? operationForWorkflowToolCall(workflowRun, toolName)
      : operationForToolCall(claims, toolName);
    try {
      const result = await agentGateway.callAgentTool(
        boundTargetId,
        toolName,
        args,
        stableAgentRequestId(claims.runId, req.body.toolCallId)
      );
      const text = typeof result === 'string' ? result : JSON.stringify(result);
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
            workflowRunId: workflowRun.workflowRunId,
            workflowSessionId: workflowRun.workflowSessionId,
            workflowStepId: workflowRun.workflowStepId || null
          } : {}),
          durationMs: Date.now() - startedAt,
          isError: false
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
            workflowRunId: workflowRun.workflowRunId,
            workflowSessionId: workflowRun.workflowSessionId,
            workflowStepId: workflowRun.workflowStepId || null
          } : {}),
          durationMs: Date.now() - startedAt,
          isError: false
        }
      });
      res.status(200).json({
        content: [{ type: 'text', text }],
        isError: false
      });
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
      res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify(publicError) }],
        isError: true
      });
      return;
    }
  } catch (err) {
    next(err);
  }
}
