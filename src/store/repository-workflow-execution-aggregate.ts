import type { PoolClient } from 'pg';
import { withTransaction } from './repository-transaction.js';

export function deriveWorkflowExecutionAggregateStatus(
  rootStatus: string,
  children: Array<{ status: string; required: boolean }>
): string {
  if (['completed', 'failed', 'cancelled'].includes(rootStatus)) return rootStatus;
  const requiredChildren = children.filter((child) => child.required);
  if (rootStatus === 'needs_review' || requiredChildren.some((child) => child.status === 'needs_review')) {
    return 'needs_review';
  }
  if (
    rootStatus === 'waiting_for_approval'
    || requiredChildren.some((child) => child.status === 'waiting_for_approval')
  ) {
    return 'waiting_for_approval';
  }
  return rootStatus;
}

export async function recomputeWorkflowExecutionStatus(
  client: PoolClient,
  runId: string
): Promise<string | undefined> {
  const executionResult = await client.query<{ execution_id: string }>(
    'SELECT execution_id FROM workflow_runs WHERE id=$1',
    [runId]
  );
  const executionId = executionResult.rows[0]?.execution_id;
  if (!executionId) return undefined;

  const currentResult = await client.query<{ status: string }>(
    'SELECT status FROM workflow_executions WHERE id=$1 FOR UPDATE',
    [executionId]
  );
  const currentStatus = currentResult.rows[0]?.status;
  if (!currentStatus) return undefined;
  if (['completed', 'failed', 'cancelled'].includes(currentStatus)) return currentStatus;

  const rootResult = await client.query<{
    id: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
    ended_at: string | null;
  }>(
    `SELECT id,status,error_code,error_message,ended_at
     FROM workflow_runs
     WHERE execution_id=$1 AND parent_run_id IS NULL
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [executionId]
  );
  const root = rootResult.rows[0];
  if (!root) return currentStatus;

  const childrenResult = await client.query<{
    status: string;
    delegation_required: boolean;
  }>(
    `SELECT status,delegation_required
     FROM workflow_runs
     WHERE parent_run_id=$1`,
    [root.id]
  );
  const rootTerminal = ['completed', 'failed', 'cancelled'].includes(root.status);
  const rootCarriesError = rootTerminal || root.status === 'needs_review';
  const aggregateStatus = deriveWorkflowExecutionAggregateStatus(
    root.status,
    childrenResult.rows.map((child) => ({
      status: child.status,
      required: child.delegation_required
    }))
  );

  await client.query(
    `UPDATE workflow_executions
     SET status=$2,
         error_code=CASE WHEN $3::boolean THEN $4 ELSE NULL END,
         error_message=CASE WHEN $3::boolean THEN $5 ELSE NULL END,
         ended_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE NULL END,
         updated_at=NOW()
     WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
    [
      executionId,
      aggregateStatus,
      rootCarriesError,
      root.error_code,
      root.error_message,
      rootTerminal,
      root.ended_at
    ]
  );
  return aggregateStatus;
}

export async function recomputeWorkflowExecutionStatusForRun(
  runId: string
): Promise<string | undefined> {
  return withTransaction((client) => recomputeWorkflowExecutionStatus(client, runId));
}
