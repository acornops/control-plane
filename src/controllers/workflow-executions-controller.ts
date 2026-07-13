import type { NextFunction, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { resumeWorkflowExecution } from '../services/workflow-state-machine.js';
import { toSingleParam } from '../utils/params.js';

async function execution(id: string): Promise<QueryResultRow | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM workflow_executions WHERE id=$1', [id]);
  return result.rowCount ? result.rows[0] : null;
}

export async function getWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const row = await execution(id);
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, row.workspace_id, 'No access to workflow execution'))) return;
    const attempts = await db.query('SELECT * FROM workflow_runs WHERE execution_id=$1 ORDER BY step_index,attempt_number', [id]);
    res.status(200).json({ execution: row, attempts: attempts.rows });
  } catch (err) { next(err); }
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
