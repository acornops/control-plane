import type { NextFunction, Response } from 'express';
import type { QueryResultRow } from 'pg';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { resumeWorkflowExecution } from '../services/workflow-state-machine.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listWorkflowDelegations } from '../store/repository-workflow-delegations.js';
import { withTransaction } from '../store/repository-transaction.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';
import { publicCompiledWorkflowScope, publicWorkflowDefinition } from './workflow-public.js';

async function execution(id: string): Promise<QueryResultRow | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM workflow_executions WHERE id=$1', [id]);
  return result.rowCount ? result.rows[0] : null;
}

function boundedFailureCode(value?: string): string {
  return (value || 'DELEGATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 100);
}

export async function getWorkflowExecution(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = toSingleParam(req.params.executionId);
    const row = await execution(id);
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow execution not found', retryable: false } }); return; }
    if (!(await requireWorkspaceDataRead(req, res, row.workspace_id, 'No access to workflow execution'))) return;
    const attempts = await db.query('SELECT * FROM workflow_runs WHERE execution_id=$1 ORDER BY attempt_number', [id]);
    const snapshot = row.workflow_snapshot as WorkflowDefinitionForAccess | undefined;
    const coordinated = snapshot?.executionMode === 'coordinated' || (snapshot?.agentIds?.length || 0) > 1;
    const coordination = coordinated
      ? await Promise.all((await listWorkflowDelegations(id)).map(async (delegation) => {
        const agent = await getAgentDefinition(row.workspace_id, delegation.selectedAgentId);
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
    const publicAttempts = attempts.rows.map((attempt) => {
      const {
        agent_id: _agentId,
        agent_version: _agentVersion,
        agent_snapshot: _agentSnapshot,
        compiled_access_scope: compiledScope,
        ...publicAttempt
      } = attempt;
      return {
        ...publicAttempt,
        ...(compiledScope ? { compiled_access_scope: publicCompiledWorkflowScope(compiledScope) } : {})
      };
    });
    res.status(200).json({
      execution: {
        ...row,
        ...(snapshot ? { workflow_snapshot: publicWorkflowDefinition(snapshot) } : {})
      },
      attempts: publicAttempts,
      ...(coordination ? {
        coordination: {
          label: 'AcornOps coordination',
          status: row.status,
          children: coordination
        }
      } : {})
    });
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
