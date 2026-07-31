import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { db } from '../infra/db.js';
import type {
  WorkflowWebhookInput,
  WorkflowWebhookLastStatus,
  WorkflowWebhookPatch,
  WorkflowWebhookRecord
} from '../types/workflows.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

export interface ClaimedWorkflowWebhookDelivery {
  id: string;
  eventId: string;
  workspaceId: string;
  webhook: WorkflowWebhookRecord;
  occurrenceKey: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  attemptCount: number;
}

function actorMetadata(userId: string): { userId: string } {
  return { userId };
}

function mapWebhook(row: QueryResultRow): WorkflowWebhookRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersion: Number(row.workflow_version),
    parameterSignature: row.parameter_signature,
    name: row.name,
    status: row.status,
    approvedContextGrants: Array.isArray(row.approved_context_grants) ? row.approved_context_grants : [],
    principal: row.principal,
    secretCiphertext: row.secret_ciphertext,
    secretKeyId: row.secret_key_id,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    ...(row.last_received_at ? { lastReceivedAt: toIso(row.last_received_at)! } : {}),
    ...(row.last_status ? { lastStatus: row.last_status } : {}),
    ...(row.last_execution_id ? { lastExecutionId: row.last_execution_id } : {}),
    ...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

export async function listWorkflowWebhooks(workspaceId: string): Promise<WorkflowWebhookRecord[]> {
  const result = await db.query(
    `SELECT *
     FROM workflow_webhooks
     WHERE workspace_id=$1
     ORDER BY created_at DESC,id`,
    [workspaceId]
  );
  return result.rows.map(mapWebhook);
}

export async function getWorkflowWebhook(webhookId: string): Promise<WorkflowWebhookRecord | null> {
  const result = await db.query(
    'SELECT * FROM workflow_webhooks WHERE id=$1',
    [webhookId]
  );
  return result.rowCount ? mapWebhook(result.rows[0]) : null;
}

export async function createWorkflowWebhook(params: {
  workspaceId: string;
  workflowVersion: number;
  parameterSignature: string;
  actorUserId: string;
  input: WorkflowWebhookInput;
  secretCiphertext: string;
  secretKeyId: string;
}): Promise<WorkflowWebhookRecord> {
  const id = randomUUID();
  const actor = actorMetadata(params.actorUserId);
  const result = await db.query(
    `INSERT INTO workflow_webhooks (
       id,workspace_id,workflow_id,workflow_version,parameter_signature,name,status,
       approved_context_grants,principal,secret_ciphertext,secret_key_id,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb,$12::jsonb
     ) RETURNING *`,
    [
      id,
      params.workspaceId,
      params.input.workflowId,
      params.workflowVersion,
      params.parameterSignature,
      params.input.name.trim(),
      params.input.enabled === false ? 'paused' : 'enabled',
      JSON.stringify(params.input.approvedContextGrants || []),
      JSON.stringify(params.input.principal),
      params.secretCiphertext,
      params.secretKeyId,
      JSON.stringify(actor)
    ]
  );
  return mapWebhook(result.rows[0]);
}

export async function updateWorkflowWebhookRecord(
  webhookId: string,
  patch: WorkflowWebhookPatch & {
    workflowVersion?: number;
    parameterSignature?: string;
  },
  actorUserId: string
): Promise<WorkflowWebhookRecord | null> {
  const current = await getWorkflowWebhook(webhookId);
  if (!current) return null;
  const status = typeof patch.enabled === 'boolean'
    ? patch.enabled ? 'enabled' : 'paused'
    : current.status;
  const result = await db.query(
    `UPDATE workflow_webhooks
     SET workflow_version=$2,
         parameter_signature=$3,
         name=$4,
         status=$5,
         approved_context_grants=$6::jsonb,
         principal=$7::jsonb,
         updated_by=$8::jsonb,
         updated_at=NOW(),
         last_error=CASE WHEN $5='enabled' THEN NULL ELSE last_error END
     WHERE id=$1
     RETURNING *`,
    [
      webhookId,
      patch.workflowVersion || current.workflowVersion,
      patch.parameterSignature || current.parameterSignature,
      patch.name?.trim() || current.name,
      status,
      JSON.stringify(patch.approvedContextGrants || current.approvedContextGrants),
      JSON.stringify(current.principal),
      JSON.stringify(actorMetadata(actorUserId))
    ]
  );
  return result.rowCount ? mapWebhook(result.rows[0]) : null;
}

export async function deleteWorkflowWebhookRecord(webhookId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const deliveries = await client.query<{ event_id: string }>(
      'DELETE FROM workflow_webhook_deliveries WHERE webhook_id=$1 RETURNING event_id',
      [webhookId]
    );
    const eventIds = deliveries.rows.map((row) => row.event_id);
    if (eventIds.length) {
      await client.query(
        `DELETE FROM workflow_webhook_events event
         WHERE event.id=ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM workflow_webhook_deliveries delivery WHERE delivery.event_id=event.id
           )`,
        [eventIds]
      );
    }
    const result = await client.query('DELETE FROM workflow_webhooks WHERE id=$1', [webhookId]);
    return Boolean(result.rowCount);
  });
}

export async function rotateWorkflowWebhookSecret(
  webhookId: string,
  secretCiphertext: string,
  secretKeyId: string,
  actorUserId: string
): Promise<WorkflowWebhookRecord | null> {
  const result = await db.query(
    `UPDATE workflow_webhooks
     SET secret_ciphertext=$2,secret_key_id=$3,updated_by=$4::jsonb,updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [webhookId, secretCiphertext, secretKeyId, JSON.stringify(actorMetadata(actorUserId))]
  );
  return result.rowCount ? mapWebhook(result.rows[0]) : null;
}

export async function acceptWorkflowWebhookEvent(input: {
  webhook: WorkflowWebhookRecord;
  eventId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  maxEventsPerMinute: number;
}): Promise<'accepted' | 'replayed' | 'inactive' | 'rate_limited'> {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT 1
       FROM workflow_webhooks
       WHERE id=$1
         AND workspace_id=$2
         AND status='enabled'
         AND secret_ciphertext=$3
       FOR UPDATE`,
      [input.webhook.id, input.webhook.workspaceId, input.webhook.secretCiphertext]
    );
    if (!current.rowCount) return 'inactive';
    const replay = await client.query(
      `SELECT 1
       FROM workflow_webhook_events
       WHERE workspace_id=$1
         AND webhook_id=$2
         AND occurrence_key=$3
       LIMIT 1`,
      [input.webhook.workspaceId, input.webhook.id, input.eventId]
    );
    if (replay.rowCount) return 'replayed';
    const recent = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM workflow_webhook_events
       WHERE webhook_id=$1
         AND created_at > NOW()-INTERVAL '1 minute'`,
      [input.webhook.id]
    );
    if (Number(recent.rows[0]?.count || 0) >= input.maxEventsPerMinute) return 'rate_limited';
    const internalEventId = randomUUID();
    const event = await client.query(
      `INSERT INTO workflow_webhook_events (
         id,workspace_id,webhook_id,occurrence_key,payload,occurred_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (workspace_id,webhook_id,occurrence_key) DO NOTHING
       RETURNING id`,
      [
        internalEventId,
        input.webhook.workspaceId,
        input.webhook.id,
        input.eventId,
        JSON.stringify(input.payload),
        input.occurredAt
      ]
    );
    if (!event.rowCount) return 'replayed';
    await client.query(
      `INSERT INTO workflow_webhook_deliveries (id,event_id,workspace_id,webhook_id,status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), internalEventId, input.webhook.workspaceId, input.webhook.id]
    );
    return 'accepted';
  });
}

export async function claimWorkflowWebhookDeliveries(
  limit: number,
  claimOwner: string
): Promise<ClaimedWorkflowWebhookDelivery[]> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT delivery.id
         FROM workflow_webhook_deliveries delivery
         JOIN workflow_webhooks webhook
           ON webhook.id=delivery.webhook_id
         WHERE (
             delivery.status IN ('pending','failed')
             OR (delivery.status='claimed' AND delivery.claim_expires_at < NOW())
           )
           AND delivery.next_attempt_at <= NOW()
         ORDER BY delivery.created_at,delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT $1
       )
       UPDATE workflow_webhook_deliveries delivery
       SET status='claimed',
           claim_owner=$2,
           claim_expires_at=NOW()+INTERVAL '5 minutes',
           updated_at=NOW()
       FROM candidates,workflow_webhooks webhook,workflow_webhook_events event
       WHERE delivery.id=candidates.id
         AND webhook.id=delivery.webhook_id
         AND event.id=delivery.event_id
       RETURNING delivery.id,delivery.event_id,delivery.workspace_id,delivery.attempt_count,
         to_jsonb(webhook) AS webhook_row,event.occurrence_key,event.payload,event.occurred_at`,
      [Math.max(1, Math.min(100, limit)), claimOwner]
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      webhook: mapWebhook(row.webhook_row),
      occurrenceKey: row.occurrence_key,
      payload: row.payload || {},
      occurredAt: toIso(row.occurred_at)!,
      attemptCount: Number(row.attempt_count)
    }));
  });
}

export async function finishWorkflowWebhookDelivery(input: {
  delivery: ClaimedWorkflowWebhookDelivery;
  status: 'delivered' | 'failed' | 'rejected';
  webhookStatus: WorkflowWebhookLastStatus;
  executionId?: string;
  runId?: string;
  error?: string;
  pauseWebhook?: boolean;
}): Promise<void> {
  const nextAttempt = input.status === 'failed'
    ? `NOW() + (${Math.min(30, 2 ** (input.delivery.attemptCount + 1))}::int * INTERVAL '1 second')`
    : 'NOW()';
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE workflow_webhook_deliveries
       SET status=$2,
           attempt_count=attempt_count+1,
           next_attempt_at=${nextAttempt},
           rejection_code=$3,
           claim_owner=NULL,
           claim_expires_at=NULL,
           updated_at=NOW()
       WHERE id=$1`,
      [
        input.delivery.id,
        input.status,
        input.status === 'rejected' ? input.error || 'WEBHOOK_REJECTED' : null
      ]
    );
    await client.query(
      `UPDATE workflow_webhooks
       SET status=CASE WHEN $6 THEN 'paused' ELSE status END,
           last_received_at=NOW(),
           last_status=$2,
           last_execution_id=COALESCE($3,last_execution_id),
           last_run_id=COALESCE($4,last_run_id),
           last_error=$5,
           updated_at=NOW()
       WHERE id=$1`,
      [
        input.delivery.webhook.id,
        input.webhookStatus,
        input.executionId || null,
        input.runId || null,
        input.error || null,
        input.pauseWebhook === true
      ]
    );
  });
}
