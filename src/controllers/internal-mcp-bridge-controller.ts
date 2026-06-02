import { NextFunction, Request, Response } from 'express';
import { agentGateway } from '../agent/ws-server.js';
import { type VerifiedRunScopeClaims } from '../services/token-service.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';

const ACTIVE_TOOL_RUN_STATUSES = new Set(['dispatching', 'running', 'waiting_for_approval']);

function isToolAllowedByRunToken(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes('*') || allowedTools.includes(toolName);
}

export function operationForToolCall(claims: Pick<VerifiedRunScopeClaims, 'allowedToolOperations'>, toolName: string): 'read' | 'write' {
  return claims.allowedToolOperations?.[toolName] === 'read' ? 'read' : 'write';
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
    const workspaceId = claims.workspaceId;
    const targetId = claims.targetId;
    const targetType = claims.targetType;
    if (targetType !== KUBERNETES_TARGET_TYPE && targetType !== VIRTUAL_MACHINE_TARGET_TYPE) {
      res.status(400).json({
        error: { code: 'UNSUPPORTED_TARGET_TYPE', message: 'Built-in tools require a supported target type', retryable: false }
      });
      return;
    }
    const run = await repo.getRun(claims.runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (
      run.workspaceId !== workspaceId ||
      run.targetId !== targetId ||
      run.targetType !== targetType ||
      run.sessionId !== claims.sessionId
    ) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Run token scope does not match run', retryable: false } });
      return;
    }
    if (!ACTIVE_TOOL_RUN_STATUSES.has(run.status)) {
      res.status(409).json({ error: { code: 'RUN_NOT_ACTIVE', message: 'Run is not active for tool execution', retryable: false } });
      return;
    }
    const target = await repo.getTarget(workspaceId, targetId);
    if (!target || target.targetType !== targetType) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
      return;
    }

    const startedAt = Date.now();
    const operation = operationForToolCall(claims, toolName);
    try {
      const result = await agentGateway.callAgentTool(targetId, toolName, args);
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
        targetType: 'tool_call',
        targetId: `${targetId}:${toolName}:${startedAt}`,
        targetName: toolName,
        summary: 'Built-in MCP tool called',
        metadata: {
          targetId,
          targetType,
          toolName,
          source: 'builtin_mcp_bridge',
          runId: claims.runId,
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
      const message = err instanceof Error ? err.message : 'Agent tool call failed';
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
        targetType: 'tool_call',
        targetId: `${targetId}:${toolName}:${startedAt}`,
        targetName: toolName,
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
        content: [{ type: 'text', text: message }],
        isError: true
      });
      return;
    }
  } catch (err) {
    next(err);
  }
}
