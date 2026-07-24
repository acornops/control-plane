import type { NextFunction, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import { incrementWorkflowExecutionStream } from '../metrics.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { WorkflowAccessDeniedError } from '../services/workflow-access.js';
import { getWorkflowCapabilityReadinessReport, publicMcpReadinessError } from '../services/workflow-readiness.js';
import { cancelWorkflowExecutionGraph } from '../services/workflow-execution-cancellation.js';
import { resumeWorkflowExecution } from '../services/workflow-state-machine.js';
import { listWorkflowExecutionEvents, type WorkflowExecutionStreamEvent } from '../store/repository-workflow-execution-events.js';
import {
  getWorkflowExecution as getWorkflowExecutionRecord,
  listWorkflowChildRuns,
  listWorkflowExecutionAttempts
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { repo } from '../store/repository.js';
import { isTargetType } from '../types/domain.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';
import { publicWorkflowDefinition, respondWorkflowAccessError } from './workflow-public.js';
import { publicWorkflowExecutionEvent, publicWorkflowRun } from './external-run-public.js';

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

function boundedFailureCode(value?: string): string {
  return (value || 'DELEGATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 100);
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
    const rootAttempts = await listWorkflowExecutionAttempts(id);
    const latestRoot = rootAttempts.at(-1);
    const coordination = coordinated && latestRoot
      ? (await listWorkflowChildRuns(latestRoot.id)).map((child) => {
        const specialistSnapshot = child.executorSnapshot.role === 'specialist' ? child.executorSnapshot.agent : undefined;
        return {
          childRunId: child.id,
          capabilityId: child.delegationCapabilityId,
          target: { id: child.targetId, targetType: child.targetType },
          agent: { id: child.agentId, name: specialistSnapshot?.name || 'Unavailable Agent' },
          required: child.delegationRequired,
          status: child.status,
          ...(child.errorCode || child.errorMessage ? {
            failure: {
              code: boundedFailureCode(child.errorCode),
              message: (child.errorMessage || 'Delegated work failed.').slice(0, 500)
            }
          } : {})
        };
      })
      : undefined;
    const externalRequest = req.auth.credential.type === 'external_integration';
    const publicAttempts = rootAttempts.map((attempt) => publicWorkflowRun(attempt, false));
    res.status(200).json({
      execution: externalRequest
        ? publicExecution(record)
        : {
            ...publicExecution(record),
            ...(snapshot ? { workflowSnapshot: publicWorkflowDefinition(snapshot) } : {})
          },
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
  const output = publicWorkflowExecutionEvent(event);
  res.write(`event: workflow_execution\nid: ${output.id}\ndata: ${JSON.stringify(output)}\n\n`);
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
    const runIds = await cancelWorkflowExecutionGraph(id);
    await Promise.all(runIds.map((runId) => cancelRunInExecutionEngine(runId).catch(() => undefined)));
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
    const attempts = await listWorkflowExecutionAttempts(id);
    const previous = attempts.at(-1);
    if (!previous) {
      res.status(409).json({ error: { code: 'WORKFLOW_RUN_NOT_FOUND', message: 'The pinned root run is unavailable.', retryable: false } });
      return;
    }
    const targetRoute = previous.targetId && previous.targetType && isTargetType(previous.targetType)
      ? { id: previous.targetId, targetType: previous.targetType }
      : undefined;
    const target = targetRoute
      ? await repo.getTarget(row.workspace_id, targetRoute.id) || undefined
      : undefined;
    if (targetRoute && !target) {
      res.status(409).json({ error: { code: 'PROMPT_REFERENCE_NOT_FOUND', message: 'The bound target is no longer available.', retryable: false } });
      return;
    }
    const pinnedScope = previous.compiledAccessScope;
    const mcpReadiness = await getWorkflowCapabilityReadinessReport(
      row.workspace_id,
      pinnedScope,
      target,
      { principal: pinnedScope.principal }
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
        executorRole: pinnedScope.executor.role,
        specialistSnapshot: previous.executorSnapshot.role === 'specialist'
          ? previous.executorSnapshot.agent
          : undefined,
        targetId: targetRoute?.id,
        targetType: targetRoute?.targetType,
        compiledAccessScope: pinnedScope,
        prompt,
        promptDigest: previous.promptDigest,
        bindingDigest: previous.bindingDigest,
        resourceBindings: previous.resourceBindings,
        resolvedAt: previous.resolvedAt
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
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: WORKFLOW_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
