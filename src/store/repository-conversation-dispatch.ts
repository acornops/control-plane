import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Acceptance and delivery intent commit together. The existing worker queue is reused. */
export async function insertConversationDispatch(client: Pick<PoolClient, 'query'>, workspaceId: string, runId: string): Promise<void> {
  await client.query(`INSERT INTO automation_dispatch_outbox(id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
    VALUES($1,$2,'conversation',$3,$3,$4,$5::jsonb) ON CONFLICT(idempotency_key) DO NOTHING`,
  [randomUUID(), workspaceId, runId, `conversation:${runId}`, JSON.stringify({ runId })]);
}

/** Requeue only a dispatch explicitly rejected before admission by the engine. */
export async function deferConversationDispatch(client: Pick<PoolClient, 'query'>, runId: string): Promise<void> {
  const run = await client.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM runs WHERE id=$1 AND status IN ('queued','dispatching') FOR UPDATE", [runId]);
  if (!run.rowCount) return;
  await client.query(`INSERT INTO automation_dispatch_outbox(id,workspace_id,source_type,source_id,run_id,idempotency_key,payload,next_attempt_at)
    VALUES($1,$2,'conversation',$3,$3,$4,$5::jsonb,NOW()+INTERVAL '1 second')
    ON CONFLICT(idempotency_key) DO UPDATE SET status='pending',next_attempt_at=NOW()+INTERVAL '1 second',
      claim_owner=NULL,claim_expires_at=NULL,last_error_code='SERVICE_DRAINING',updated_at=NOW()
    WHERE automation_dispatch_outbox.status IN ('pending','failed','delivered','needs_review')`,
  [randomUUID(), run.rows[0].workspace_id, runId, `conversation:${runId}`, JSON.stringify({ runId })]);
}
