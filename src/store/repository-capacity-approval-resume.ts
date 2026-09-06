import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/** Rebase eligibility only with the first durable transition out of approval wait. */
export async function resumeCapacityAfterApproval(
  client: PoolClient, runId: string, table: 'runs' | 'workflow_runs', status: 'queued' | 'dispatching'
): Promise<boolean> {
  await client.query(`SELECT w.id FROM workspaces w JOIN ${table} run ON run.workspace_id=w.id
    WHERE run.id=$1 FOR UPDATE OF w`, [runId]);
  const updatedAt = table === 'workflow_runs' ? ',updated_at=clock_timestamp()' : '';
  const resumed = await client.query(`UPDATE ${table} SET status=$2${updatedAt} WHERE id=$1 AND status='waiting_for_approval' RETURNING id`, [runId, status]);
  if (!resumed.rowCount) return false;
  await client.query(`UPDATE workspace_run_reservations SET eligible_at=clock_timestamp(),
    queue_expires_at=clock_timestamp()+($2::int*INTERVAL '1 second')
    WHERE run_id=$1 AND settled_at IS NULL AND state IN ('queued','parked')`, [runId, config.WORKSPACE_CAPACITY_QUEUE_SECONDS]);
  if (table === 'runs') {
    await client.query(`INSERT INTO automation_dispatch_outbox(id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
      SELECT $1,workspace_id,'conversation',id,id,$3,$4::jsonb FROM runs WHERE id=$2
      ON CONFLICT(idempotency_key) DO UPDATE SET status='pending',next_attempt_at=clock_timestamp(),
        claim_owner=NULL,claim_expires_at=NULL,delivered_at=NULL,updated_at=clock_timestamp()`,
    [randomUUID(), runId, `conversation:${runId}`, JSON.stringify({ runId, resume: true })]);
  }
  return true;
}
