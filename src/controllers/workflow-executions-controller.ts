import type { NextFunction, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import { incrementWorkflowExecutionStream } from '../metrics.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { promptResourceRegistry, PromptResourceProviderError } from '../services/prompt-resources/index.js';
import { narrowWorkflowScopeToTargetTools } from '../services/workflow-capability-preview.js';
import { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { getWorkflowCapabilityReadinessReport, publicMcpReadinessError } from '../services/workflow-readiness.js';
import { compileWorkflowScope } from '../services/workflow-scope-compiler.js';
import { resumeWorkflowExecution } from '../services/workflow-state-machine.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listWorkflowDelegations } from '../store/repository-workflow-delegations.js';
import { listWorkflowExecutionEvents, type WorkflowExecutionStreamEvent } from '../store/repository-workflow-execution-events.js';
import {
  getWorkflowExecution as getWorkflowExecutionRecord,
  listWorkflowExecutionAttempts
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { withTransaction } from '../store/repository-transaction.js';
import { repo } from '../store/repository.js';
import { isTargetType, type TargetSummary } from '../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';
import { publicCompiledWorkflowScope, publicWorkflowDefinition, respondWorkflowAccessError } from './workflow-public.js';

const WORKFLOW_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';

async function execution(id: string): Promise<QueryResultRow | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM workflow_executions WHERE id=$1', [id]);
  return result.rowCount ? result.rows[0] : null;
}

function publicExecution(record: NonNullable<Awaited<ReturnType<typeof getWorkflowExecutionRecord>>>) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    workflowSessionId: record.workflowSessionId,
    status: record.status,
    triggerType: record.triggerType,
    errorCode: record.errorCode?.slice(0, 128) || null,
    startedAt: record.startedAt || null,
    endedAt: record.endedAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function publicAttempt(attempt: Awaited<ReturnType<typeof listWorkflowExecutionAttempts>>[number]) {
  return {
    id: attempt.id,
    executionId: attempt.executionId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    targetId: attempt.targetId || null,
    targetType: attempt.targetType || null,
    requestedAt: attempt.requestedAt,
    startedAt: attempt.startedAt || null,
    endedAt: attempt.endedAt || null,
    errorCode: attempt.errorCode?.slice(0, 128) || null
  };
}

function boundedFailureCode(value?: string): string {
  return (value || 'DELEGATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 100);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export async function getWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const record = await getWorkflowExecutionRecord(id);
    if (!record) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, record.workspaceId, 'No access to workflow execution'))) return;
    const row = await execution(id);
    const snapshot = row?.workflow_snapshot as WorkflowDefinitionForAccess | undefined;
    const coordinated = snapshot?.executionMode === 'coordinated' || (snapshot?.agentIds?.length || 0) > 1;
    const coordination = coordinated
      ? await Promise.all((await listWorkflowDelegations(id)).map(async (delegation) => {
        const agent = await getAgentDefinition(record.workspaceId, delegation.selectedAgentId);
        return {
          id: delegation.id,
          childRunId: delegation.childRunId,
          capabilityId: delegation.capabilityId,
          target: delegation.targetBinding,
          agent: { id: delegation.selectedAgentId, name: agent?.name || 'Unavailable Agent' },
          required: delegation.required,
          status: delegation.status,
          ...(delegation.errorCode || delegation.errorMessage ? {
            failure: {
              code: boundedFailureCode(delegation.errorCode),
              message: (delegation.errorMessage || 'Delegated work failed.').slice(0, 500)
            }
          } : {})
        };
      }))
      : undefined;
    const externalRequest = req.auth.credential.type === 'external_integration';
    const publicAttempts = externalRequest
      ? (await listWorkflowExecutionAttempts(id)).map(publicAttempt)
      : (await db.query('SELECT * FROM workflow_runs WHERE execution_id=$1 ORDER BY attempt_number', [id])).rows.map((attempt) => {
        const {
          agent_id: _agentId,
          agent_version: _agentVersion,
          agent_snapshot: _agentSnapshot,
          compiled_access_scope: compiledScope,
          ...publicAttemptRecord
        } = attempt;
        return {
          ...publicAttemptRecord,
          ...(compiledScope ? { compiled_access_scope: publicCompiledWorkflowScope(compiledScope) } : {})
        };
      });
    res.status(200).json({
      execution: externalRequest
        ? publicExecution(record)
        : { ...row, ...(snapshot ? { workflow_snapshot: publicWorkflowDefinition(snapshot) } : {}) },
      attempts: publicAttempts,
      ...(coordination ? {
        coordination: {
          label: 'AcornOps coordination',
          status: record.status,
          children: coordination
        }
      } : {})
    });
  } catch (err) { next(err); }
}

function writeExecutionEvent(res: Response, event: WorkflowExecutionStreamEvent): void {
  res.write(`event: workflow_execution\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

function resumeCursor(req: AuthenticatedRequest): number {
  const value = req.query.after ?? req.headers['last-event-id'];
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function streamWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const record = await getWorkflowExecutionRecord(id);
    if (!record) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } });
      return;
    }
    if (!(await requireWorkspaceDataRead(req, res, record.workspaceId, 'No access to workflow execution'))) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    incrementWorkflowExecutionStream('opened');

    const buffered: WorkflowExecutionStreamEvent[] = [];
    let replaying = true;
    let lastEventId = resumeCursor(req);
    const listener = ({ event }: { event: WorkflowExecutionStreamEvent }) => {
      if (replaying) {
        buffered.push(event);
        return;
      }
      if (Number(event.id) <= lastEventId) return;
      lastEventId = Number(event.id);
      writeExecutionEvent(res, event);
    };
    runtime.workflowExecutionStreams.on(`workflow-execution:${id}`, listener);

    try {
      const replay = await listWorkflowExecutionEvents(id, lastEventId);
      if (replay.length > 0) incrementWorkflowExecutionStream('replayed', replay.length);
      for (const event of replay) {
        lastEventId = Math.max(lastEventId, Number(event.id));
        writeExecutionEvent(res, event);
      }
      replaying = false;
      for (const event of buffered.sort((left, right) => Number(left.id) - Number(right.id))) {
        if (Number(event.id) <= lastEventId) continue;
        lastEventId = Number(event.id);
        writeExecutionEvent(res, event);
      }
    } catch (err) {
      runtime.workflowExecutionStreams.off(`workflow-execution:${id}`, listener);
      throw err;
    }

    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      incrementWorkflowExecutionStream('closed');
      clearInterval(keepAlive);
      runtime.workflowExecutionStreams.off(`workflow-execution:${id}`, listener);
    });
  } catch (err) {
    incrementWorkflowExecutionStream('error');
    next(err);
  }
}

export async function cancelWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const row = await execution(id);
    if (!row) { res.status(202).json({ status: 'accepted' }); return; }
    const authz = await requireWorkspaceDataRead(req, res, row.workspace_id, 'No access to workflow execution');
    if (!authz) return;
    if (!authz.can('cancel_runs')) { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No permission to cancel workflow executions', retryable: false } }); return; }
    const cancellation = await withTransaction(async (client) => {
      await client.query('SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE', [id]);
      const latest = await client.query<{ id: string }>('SELECT id FROM workflow_runs WHERE execution_id=$1 ORDER BY attempt_number DESC LIMIT 1', [id]);
      const delegatedChildren = await client.query<{ child_run_id: string }>(
        `SELECT child_run_id FROM workflow_delegations
         WHERE parent_execution_id=$1
           AND child_run_id IS NOT NULL
           AND status IN ('queued','running')
         FOR UPDATE`,
        [id]
      );
      const childRunIds = delegatedChildren.rows.map((child) => child.child_run_id);
      await client.query("UPDATE workflow_executions SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')", [id]);
      await client.query("UPDATE workflow_runs SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW() WHERE execution_id=$1 AND status NOT IN ('completed','failed','cancelled')", [id]);
      await client.query("UPDATE automation_dispatch_outbox SET status='cancelled',updated_at=NOW() WHERE source_type='workflow' AND source_id=$1 AND status<>'delivered'", [id]);
      await client.query(
        `UPDATE workflow_delegations
         SET status='cancelled',error_code='PARENT_WORKFLOW_CANCELLED',
             error_message='Parent workflow execution was cancelled.',updated_at=NOW()
         WHERE parent_execution_id=$1 AND status IN ('queued','running')`,
        [id]
      );
      if (childRunIds.length > 0) {
        await client.query(
        `UPDATE agent_activity
         SET status='cancelled',ended_at=COALESCE(ended_at,NOW()),
             error_code=COALESCE(error_code,'PARENT_WORKFLOW_CANCELLED'),
             error_message=COALESCE(error_message,'Parent workflow execution was cancelled.'),updated_at=NOW()
         WHERE id=ANY($1::text[])
           AND status NOT IN ('completed','failed','cancelled')`,
        [childRunIds]
      );
        await client.query(
        `UPDATE automation_dispatch_outbox
         SET status='cancelled',updated_at=NOW()
         WHERE run_id=ANY($1::text[]) AND status<>'delivered'`,
        [childRunIds]
      );
      }
      return { childRunIds, latestRunId: latest.rows[0]?.id };
    });
    await Promise.all([
      ...(cancellation.latestRunId ? [cancelRunInExecutionEngine(cancellation.latestRunId).catch(() => undefined)] : []),
      ...cancellation.childRunIds.map((childRunId) => cancelRunInExecutionEngine(childRunId).catch(() => undefined))
    ]);
    res.status(202).json({ status: 'accepted' });
  } catch (err) { next(err); }
}

export async function resumeWorkflowExecutionController(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const row = await execution(id);
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    const workflow = row.workflow_snapshot as WorkflowDefinitionForAccess | undefined;
    if (!workflow) {
      res.status(409).json({ error: { code: 'WORKFLOW_VERSION_UNAVAILABLE', message: 'Workflow definition is unavailable.', retryable: false } });
      return;
    }
    const mode = workflow.capabilityPolicy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    const authz = await requireWorkspaceCapability(req, res, row.workspace_id, mode, 'No permission to resume workflow execution');
    if (!authz) return;
    if (!['failed', 'needs_review'].includes(row.status)) {
      res.status(409).json({ error: { code: 'WORKFLOW_EXECUTION_NOT_RESUMABLE', message: 'Workflow execution is not resumable.', retryable: false } });
      return;
    }
    const prompt = typeof row.prompt_text === 'string' ? row.prompt_text : '';
    if (!prompt.trim()) {
      res.status(409).json({ error: { code: 'WORKFLOW_PROMPT_UNAVAILABLE', message: 'The exact Workflow prompt is unavailable.', retryable: false } });
      return;
    }
    const resolution = await promptResourceRegistry.resolve(prompt, {
      workspaceId: row.workspace_id,
      actorUserId: req.auth.userId,
      workflowId: row.workflow_id,
      workflowSessionId: row.workflow_session_id,
      initiatingMessageId: row.message_id,
      source: row.trigger_type === 'manual' ? 'explicit' : 'trigger',
      mode: 'launch',
      requirements: workflow.resourceRequirements || []
    });
    if (resolution.blockers.length > 0) {
      res.status(409).json({ error: {
        code: 'WORKFLOW_PROMPT_REFERENCES_BLOCKED',
        message: 'One or more prompt resource references could not be resolved for retry.',
        retryable: resolution.blockers.some((blocker) => blocker.retryable),
        details: { blockers: resolution.blockers, tokens: resolution.tokens }
      } });
      return;
    }
    const runtimeProjection = promptResourceRegistry.projectRuntime(resolution.bindings, row.message_id);
    const projectedTarget = runtimeProjection.targetRoute && typeof runtimeProjection.targetRoute === 'object'
      ? runtimeProjection.targetRoute as Record<string, unknown>
      : undefined;
    const targetRoute = projectedTarget
      && typeof projectedTarget.id === 'string'
      && typeof projectedTarget.targetType === 'string'
      && isTargetType(projectedTarget.targetType)
      ? { id: projectedTarget.id, targetType: projectedTarget.targetType }
      : undefined;
    const target: TargetSummary | undefined = targetRoute
      ? await repo.getTarget(row.workspace_id, targetRoute.id) || undefined
      : undefined;
    if (targetRoute && !target) {
      res.status(409).json({ error: { code: 'PROMPT_REFERENCE_NOT_FOUND', message: 'The bound target is no longer available.', retryable: false } });
      return;
    }
    let compiled = await compileWorkflowScope({
      workflow,
      actor: { userId: req.auth.userId, role: authz.role, permissions: authz.permissions },
      approvedContextGrants: stringArray(row.approved_context_grants),
      targetRoute,
      resourceBindings: resolution.bindings,
      promptDigest: resolution.promptDigest,
      bindingDigest: resolution.bindingDigest
    });
    if (target) {
      const toolResolution = await resolveTargetRunTools({
        workspaceId: row.workspace_id,
        targetId: target.id,
        targetType: target.targetType,
        toolAccessMode: compiled.scope.mode,
        includeNativeTools: false,
        strictMcpResolution: true
      });
      const narrowed = narrowWorkflowScopeToTargetTools({
        scope: compiled.scope,
        mappings: compiled.mappings,
        resolution: toolResolution
      });
      if (compiled.scope.targetToolRefs.length > 0 && narrowed.targetTools.allowedToolRefs.length === 0) {
        res.status(409).json({ error: { code: 'WORKFLOW_TARGET_TOOLS_UNAVAILABLE', message: 'The selected target tool catalog is unavailable.', retryable: true } });
        return;
      }
      compiled = { ...compiled, scope: narrowed.scope };
    }
    const mcpReadiness = await getWorkflowCapabilityReadinessReport(
      row.workspace_id,
      compiled.scope,
      target,
      { principal: compiled.scope.principal }
    );
    if (mcpReadiness.errors.length > 0) {
      res.status(409).json({ error: publicMcpReadinessError(mcpReadiness) });
      return;
    }
    try {
      const resumed = await resumeWorkflowExecution(id, req.auth.userId, {
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        workflowSessionId: row.workflow_session_id,
        messageId: row.message_id,
        agentId: compiled.entryAgent.id,
        agentVersion: compiled.entryAgent.version,
        agentSnapshot: compiled.entryAgent as unknown as Record<string, unknown>,
        targetId: targetRoute?.id,
        targetType: targetRoute?.targetType,
        compiledAccessScope: compiled.scope,
        prompt,
        promptDigest: resolution.promptDigest,
        bindingDigest: resolution.bindingDigest,
        resourceBindings: resolution.bindings,
        resolvedAt: resolution.resolvedAt
      });
      res.status(202).json({ executionId: id, runId: resumed.runId, status: resumed.status });
    } catch (err) {
      if (err instanceof Error && err.message === 'WORKFLOW_EXECUTION_NOT_RESUMABLE') {
        res.status(409).json({ error: { code: err.message, message: 'Workflow execution is not resumable.', retryable: false } });
        return;
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof WorkflowAccessDeniedError) return respondWorkflowAccessError(res, err);
    if (err instanceof PromptResourceProviderError) {
      res.status(409).json({ error: { code: err.code, message: err.message, retryable: err.retryable } });
      return;
    }
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: WORKFLOW_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
