import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Acceptance and delivery intent commit together. The existing worker queue is reused. */
export async function insertConversationDispatch(client: Pick<PoolClient, 'query'>, workspaceId: string, runId: string): Promise<void> {
  await client.query(`INSERT INTO automation_dispatch_outbox(id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
    VALUES($1,$2,'conversation',$3,$3,$4,$5::jsonb) ON CONFLICT(idempotency_key) DO NOTHING`,
  [randomUUID(), workspaceId, runId, `conversation:${runId}`, JSON.stringify({ runId })]);
}
