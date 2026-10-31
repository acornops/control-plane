import type { PoolClient } from 'pg';
import { withTransaction } from './repository-transaction.js';
import { recomputeWorkflowExecutionStatus } from './repository-workflow-execution-aggregate.js';
import { cancelWorkflowChildren } from './repository-workflow-child-cancellation.js';

/** Keep the user-visible summary and obsolete delivery intent with the run transition. */
export async function reconcileMaintainedWorkflowRun(client: PoolClient, runId: string): Promise<string[]> {
  const terminalRoot = await client.query<{ id: string }>(
    `SELECT run.id FROM workflow_runs run JOIN workflow_executions execution ON execution.id=run.execution_id
     WHERE run.id=$1 AND run.parent_run_id IS NULL AND run.status IN ('failed','cancelled')
       AND execution.status NOT IN ('completed','failed','cancelled')
       AND NOT EXISTS (SELECT 1 FROM workflow_runs newer WHERE newer.execution_id=run.execution_id
         AND newer.parent_run_id IS NULL AND newer.attempt_number>run.attempt_number)
     FOR UPDATE OF execution`, [runId]
  );
  const cancelledChildren = terminalRoot.rowCount ? await cancelWorkflowChildren(client, runId) : [];
  if (cancelledChildren.length) {
    // Revoke further acquisition/renewal atomically, but keep all existing lease
    // and operation accounting until ordinary capacity settlement can release it.
    await client.query("UPDATE workspace_run_reservations SET state='settling' WHERE run_id=ANY($1::text[]) AND settled_at IS NULL", [cancelledChildren]);
  }
  if (terminalRoot.rowCount) {
    await client.query('DELETE FROM workflow_dependency_continuations WHERE run_id=ANY($1::text[])', [[runId, ...cancelledChildren]]);
  }
  await recomputeWorkflowExecutionStatus(client, runId);
  await client.query(
    `UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,
       claim_expires_at=NULL,updated_at=clock_timestamp()
     WHERE run_id=$1 AND status NOT IN ('delivered','cancelled') AND EXISTS (
       SELECT 1 FROM workflow_runs WHERE id=$1 AND status IN ('failed','cancelled','cancelling'))`, [runId]
  );
  return cancelledChildren;
}

/** Older maintenance versions could settle capacity without repairing the execution summary. */
export async function reconcileStaleWorkflowMaintenanceSummaries(): Promise<string[]> {
  return withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout='250ms'");
    const stale = await client.query<{ id: string }>(
      `SELECT run.id FROM workflow_executions execution
       JOIN workflow_runs run ON run.execution_id=execution.id AND run.parent_run_id IS NULL
       WHERE execution.status NOT IN ('completed','failed','cancelled')
         AND run.status IN ('failed','cancelled')
         AND run.error_code IN ('EXECUTION_AUTHORITY_LOST','WORKSPACE_SUSPENDED')
         AND NOT EXISTS (SELECT 1 FROM workflow_runs newer WHERE newer.execution_id=execution.id
           AND newer.parent_run_id IS NULL AND newer.attempt_number>run.attempt_number)
       ORDER BY execution.id LIMIT 200 FOR UPDATE OF execution SKIP LOCKED`
    );
    const cancelledChildren: string[] = [];
    for (const run of stale.rows) cancelledChildren.push(...await reconcileMaintainedWorkflowRun(client, run.id));
    return cancelledChildren;
  });
}
