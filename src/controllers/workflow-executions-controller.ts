import type { NextFunction, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { resumeWorkflowExecution } from '../services/workflow-state-machine.js';
import { toSingleParam } from '../utils/params.js';
import { getWorkflowExecution as getWorkflowExecutionRecord, listWorkflowExecutionAttempts } from '../store/repository-workflows.js';
import { listWorkflowExecutionEvents, type WorkflowExecutionStreamEvent } from '../store/repository-workflow-execution-events.js';
import { runtime } from '../store/runtime.js';
import { incrementWorkflowExecutionStream } from '../metrics.js';

function publicExecution(executionRecord: Awaited<ReturnType<typeof getWorkflowExecutionRecord>>) {
  if (!executionRecord) return null;
  return {
    id: executionRecord.id,
    workspaceId: executionRecord.workspaceId,
    workflowId: executionRecord.workflowId,
    workflowVersion: executionRecord.workflowVersion,
    workflowSessionId: executionRecord.workflowSessionId,
    status: executionRecord.status,
    currentStepIndex: executionRecord.currentStepIndex,
    triggerType: executionRecord.triggerType,
    errorCode: executionRecord.errorCode ? executionRecord.errorCode.slice(0, 128) : null,
    startedAt: executionRecord.startedAt || null,
    endedAt: executionRecord.endedAt || null,
    createdAt: executionRecord.createdAt,
    updatedAt: executionRecord.updatedAt
  };
}

function publicAttempt(attempt: Awaited<ReturnType<typeof listWorkflowExecutionAttempts>>[number]) {
  return {
    id: attempt.id,
    executionId: attempt.executionId,
    workflowStepId: attempt.workflowStepId || null,
    stepIndex: attempt.stepIndex,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    targetId: attempt.targetId || null,
    targetType: attempt.targetType || null,
    requestedAt: attempt.requestedAt,
    startedAt: attempt.startedAt || null,
    endedAt: attempt.endedAt || null,
    errorCode: attempt.errorCode ? attempt.errorCode.slice(0, 128) : null
  };
}

async function execution(id: string): Promise<QueryResultRow | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM workflow_executions WHERE id=$1', [id]);
  return result.rowCount ? result.rows[0] : null;
}

export async function getWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const record = await getWorkflowExecutionRecord(id);
    if (!record) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, record.workspaceId, 'No access to workflow execution'))) return;
    const attempts = await listWorkflowExecutionAttempts(id);
    res.status(200).json({ execution: publicExecution(record), attempts: attempts.map(publicAttempt) });
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
    const latest = await db.query<{ id: string }>('SELECT id FROM workflow_runs WHERE execution_id=$1 ORDER BY step_index DESC,attempt_number DESC LIMIT 1', [id]);
    await db.query("UPDATE workflow_executions SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')", [id]);
    await db.query("UPDATE workflow_runs SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW() WHERE execution_id=$1 AND status NOT IN ('completed','failed','cancelled')", [id]);
    await db.query("UPDATE automation_dispatch_outbox SET status='cancelled',updated_at=NOW() WHERE source_type='workflow' AND source_id=$1 AND status<>'delivered'", [id]);
    if (latest.rowCount) await cancelRunInExecutionEngine(latest.rows[0].id).catch(() => undefined);
    res.status(202).json({ status: 'accepted' });
  } catch (err) { next(err); }
}

export async function resumeWorkflowExecutionController(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const row = await execution(id);
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    const mode = row.workflow_snapshot?.policy?.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
    if (!(await requireWorkspaceCapability(req, res, row.workspace_id, mode, 'No permission to resume workflow execution'))) return;
    try {
      const resumed = await resumeWorkflowExecution(id, req.auth.userId);
      res.status(202).json({ executionId: id, runId: resumed.runId, status: resumed.status });
    } catch (err) {
      if (err instanceof Error && err.message === 'WORKFLOW_EXECUTION_NOT_RESUMABLE') {
        res.status(409).json({ error: { code: err.message, message: 'Workflow execution is not resumable.', retryable: false } });
        return;
      }
      throw err;
    }
  } catch (err) { next(err); }
}
