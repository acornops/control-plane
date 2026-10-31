import type { PoolClient } from 'pg';

/** Reuse the root-termination cleanup for commits and capacity maintenance. */
export async function cancelWorkflowChildren(client: PoolClient, rootRunId: string): Promise<string[]> {
  const active = await client.query<{ id: string }>(
    `SELECT id FROM workflow_runs WHERE parent_run_id=$1
     AND status NOT IN ('completed','failed','cancelled') FOR UPDATE`, [rootRunId]
  );
  const ids = active.rows.map((child) => child.id);
  if (!ids.length) return ids;
  await client.query(
    `UPDATE workflow_runs SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),
       error_code='PARENT_RUN_TERMINATED',
       error_message='The coordinator root terminated before this specialist completed.',updated_at=NOW()
     WHERE id=ANY($1::text[])`, [ids]
  );
  await client.query("UPDATE workflow_run_approvals SET status='expired' WHERE run_id=ANY($1::text[]) AND status='pending'", [ids]);
  await client.query('DELETE FROM workflow_run_continuations WHERE run_id=ANY($1::text[])', [ids]);
  await client.query(
    `UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
     WHERE run_id=ANY($1::text[]) AND status<>'delivered'`, [ids]
  );
  return ids;
}
