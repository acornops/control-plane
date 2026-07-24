import { withTransaction } from '../store/repository-transaction.js';

export async function cancelWorkflowExecutionGraph(executionId: string): Promise<string[]> {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE', [executionId]);
    const activeRuns = await client.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE execution_id=$1 AND status NOT IN ('completed','failed','cancelled')
       FOR UPDATE`,
      [executionId]
    );
    const runIds = activeRuns.rows.map((run) => run.id);
    await client.query(
      `UPDATE workflow_executions
       SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
      [executionId]
    );
    await client.query(
      `UPDATE workflow_runs
       SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),updated_at=NOW()
       WHERE execution_id=$1 AND status NOT IN ('completed','failed','cancelled')`,
      [executionId]
    );
    await client.query(
      `UPDATE workflow_run_approvals approval
       SET status='expired'
       FROM workflow_runs run
       WHERE approval.run_id=run.id AND run.execution_id=$1 AND approval.status='pending'`,
      [executionId]
    );
    await client.query(
      `DELETE FROM workflow_run_continuations continuation
       USING workflow_runs run
       WHERE continuation.run_id=run.id AND run.execution_id=$1`,
      [executionId]
    );
    await client.query(
      `UPDATE automation_dispatch_outbox
       SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
       WHERE source_type='workflow' AND source_id=$1 AND status<>'delivered'`,
      [executionId]
    );
    if (runIds.length > 0) {
      await client.query(
        `UPDATE automation_dispatch_outbox
         SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE run_id=ANY($1::text[]) AND status<>'delivered'`,
        [runIds]
      );
    }
    return runIds;
  });
}
