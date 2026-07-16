import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { incrementWebhookEventEnqueued, incrementWebhookOversizeRejection } from '../metrics.js';
import type { TargetType, WebhookHistoryStatus } from '../types/domain.js';
import type { WebhookEventType } from '../types/contracts.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

type Queryable = Pick<PoolClient, 'query'> | typeof db;

export interface DurableWebhookEventInput {
  type: WebhookEventType;
  workspaceId: string;
  clusterId?: string;
  targetId?: string;
  targetType?: TargetType | string;
  subject: { type: string; id: string };
  data?: Record<string, unknown>;
  occurredAt?: string;
  dedupeKey?: string;
  snapshotRecipients?: boolean;
}

export interface ClaimedWebhookDelivery {
  jobId: string;
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: string;
  workspaceId: string;
  targetId?: string;
  targetType?: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  subscriptionId: string;
  attempts: number;
  createdAt: string;
  url?: string;
  secretCiphertext?: string;
  secretKeyId?: string;
  recipientSnapshot: boolean;
  subscriptionEnabled: boolean;
  subscriptionEventTypes: string[];
  subscriptionTargetId?: string;
  leaseRecovered: boolean;
}

export class WebhookPayloadTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`Webhook payload exceeds ${config.WEBHOOK_MAX_PAYLOAD_BYTES} bytes`);
    this.name = 'WebhookPayloadTooLargeError';
  }
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function targetId(input: DurableWebhookEventInput): string | undefined {
  return input.targetId || input.clusterId;
}

export async function enqueueWebhookOutboxEvent(
  input: DurableWebhookEventInput,
  queryable: Queryable = db,
  preparedSubscriptions?: Array<{
    id: string;
    url: string;
    secretCiphertext: string;
    secretKeyId: string;
  }>
): Promise<string | null> {
  if (queryable === db) {
    return withTransaction((client) =>
      enqueueWebhookOutboxEvent(input, client, preparedSubscriptions)
    );
  }
  const effectiveTargetId = targetId(input);
  const id = eventId();
  const occurredAt = input.occurredAt || new Date().toISOString();
  const payload = {
    id,
    type: input.type,
    occurredAt,
    workspaceId: input.workspaceId,
    ...(input.clusterId ? { clusterId: input.clusterId } : {}),
    ...(effectiveTargetId ? { targetId: effectiveTargetId } : {}),
    ...(input.targetType ? { targetType: input.targetType } : {}),
    subject: input.subject,
    data: input.data || {}
  };
  const rawPayload = JSON.stringify(payload);
  const sizeBytes = Buffer.byteLength(rawPayload);
  if (sizeBytes > config.WEBHOOK_MAX_PAYLOAD_BYTES) {
    incrementWebhookOversizeRejection();
    throw new WebhookPayloadTooLargeError(sizeBytes);
  }

  const subscriptions = preparedSubscriptions
    ? preparedSubscriptions.map((subscription) => ({
      id: subscription.id,
      url: subscription.url,
      secret_ciphertext: subscription.secretCiphertext,
      secret_key_id: subscription.secretKeyId
    }))
    : (await queryable.query(
      `SELECT id, url, secret_ciphertext, secret_key_id
       FROM webhook_subscriptions
       WHERE workspace_id = $1
         AND enabled = true
         AND event_types ? $2
         AND (target_id IS NULL OR target_id = $3)
       ORDER BY created_at ASC`,
      [input.workspaceId, input.type, effectiveTargetId || null]
    )).rows;
  if (subscriptions.length === 0) return null;

  const inserted = await queryable.query<{ id: string }>(
    `INSERT INTO webhook_outbox_events (
       id, event_type, occurred_at, workspace_id, target_id, target_type,
       subject_type, subject_id, payload, dedupe_key, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
       NOW() + ($11::int * INTERVAL '1 second'))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.type,
      occurredAt,
      input.workspaceId,
      effectiveTargetId || null,
      input.targetType || null,
      input.subject.type,
      input.subject.id,
      rawPayload,
      input.dedupeKey || null,
      config.WEBHOOK_MAX_RETRY_AGE_SECONDS
    ]
  );
  if (!inserted.rowCount) return null;
  incrementWebhookEventEnqueued(input.type);

  for (const subscription of subscriptions) {
    await queryable.query(
      `INSERT INTO webhook_delivery_jobs (
         id, event_id, subscription_id, status, next_attempt_at,
         snapshot_url, snapshot_secret_ciphertext, snapshot_secret_key_id
       ) VALUES ($1, $2, $3, 'pending', NOW(), $4, $5, $6)
       ON CONFLICT (event_id, subscription_id) DO NOTHING`,
      [
        randomUUID(),
        id,
        subscription.id,
        input.snapshotRecipients ? subscription.url : null,
        input.snapshotRecipients ? subscription.secret_ciphertext : null,
        input.snapshotRecipients ? subscription.secret_key_id : null
      ]
    );
  }
  return id;
}

export async function claimWebhookDeliveryJobs(
  limit: number,
  leaseOwner: string,
  leaseSeconds: number
): Promise<ClaimedWebhookDelivery[]> {
  const result = await db.query(
    `WITH due AS (
       SELECT job.id,
              job.status = 'processing' AND job.lease_expires_at <= NOW() AS lease_recovered
       FROM webhook_delivery_jobs job
       JOIN webhook_outbox_events event ON event.id = job.event_id
       WHERE job.status IN ('pending', 'retrying', 'processing')
         AND job.next_attempt_at <= NOW()
         AND event.expires_at > NOW()
         AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW())
       ORDER BY job.next_attempt_at ASC, job.created_at ASC
       LIMIT $1
       FOR UPDATE OF job SKIP LOCKED
     ),
     claimed AS (
       UPDATE webhook_delivery_jobs job
       SET status = 'processing',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
           updated_at = NOW()
       FROM due
       WHERE job.id = due.id
       RETURNING job.*, due.lease_recovered
     )
     SELECT
       claimed.id AS job_id,
       claimed.event_id,
       claimed.subscription_id,
       claimed.attempts,
       claimed.created_at AS job_created_at,
       claimed.snapshot_url,
       claimed.snapshot_secret_ciphertext,
       claimed.snapshot_secret_key_id,
       event.event_type,
       event.occurred_at,
       event.workspace_id,
       event.target_id,
       event.target_type,
       event.subject_type,
       event.subject_id,
       event.payload,
       subscription.url,
       subscription.secret_ciphertext,
       subscription.secret_key_id,
       subscription.enabled,
       subscription.event_types,
       subscription.target_id AS subscription_target_id
     FROM claimed
     JOIN webhook_outbox_events event ON event.id = claimed.event_id
     LEFT JOIN webhook_subscriptions subscription ON subscription.id = claimed.subscription_id`,
    [Math.max(1, Math.min(200, limit)), leaseOwner, leaseSeconds]
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: toIso(row.occurred_at)!,
    workspaceId: row.workspace_id,
    targetId: row.target_id || undefined,
    targetType: row.target_type || undefined,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload || {},
    subscriptionId: row.subscription_id,
    attempts: Number(row.attempts),
    createdAt: toIso(row.job_created_at)!,
    url: row.snapshot_url || row.url || undefined,
    secretCiphertext: row.snapshot_secret_ciphertext || row.secret_ciphertext || undefined,
    secretKeyId: row.snapshot_secret_key_id || row.secret_key_id || undefined,
    recipientSnapshot: Boolean(row.snapshot_url),
    subscriptionEnabled: row.snapshot_url ? true : row.enabled === true,
    subscriptionEventTypes: Array.isArray(row.event_types) ? row.event_types : [],
    subscriptionTargetId: row.subscription_target_id || undefined,
    leaseRecovered: row.lease_recovered === true
  }));
}

export async function getWebhookQueueMetrics(): Promise<{
  pending: number;
  retrying: number;
  paused: number;
  oldestAgeSeconds: number;
}> {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
       COUNT(*) FILTER (WHERE status = 'retrying')::text AS retrying,
       COUNT(*) FILTER (WHERE status = 'paused')::text AS paused,
       COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)::text AS oldest_age_seconds
     FROM webhook_delivery_jobs
     WHERE status IN ('pending', 'processing', 'retrying', 'paused')`
  );
  const row = result.rows[0] || {};
  return {
    pending: Number(row.pending || 0),
    retrying: Number(row.retrying || 0),
    paused: Number(row.paused || 0),
    oldestAgeSeconds: Math.max(0, Number(row.oldest_age_seconds || 0))
  };
}

export async function purgeExpiredWebhookOutboxEvents(limit = 1000): Promise<number> {
  return withTransaction(async (client) => {
    const expired = await client.query<{ id: string }>(
      `SELECT id
       FROM webhook_outbox_events
       WHERE expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.min(5000, limit))]
    );
    const eventIds = expired.rows.map((row) => row.id);
    if (eventIds.length === 0) return 0;
    await client.query(
      `INSERT INTO webhook_history (
         id, subscription_id, event_id, event_type, workspace_id, target_id,
         subject_type, subject_id, payload, status, error, attempt_number,
         will_retry, terminal_reason, sent_at
       )
       SELECT gen_random_uuid()::text, job.subscription_id, event.id, event.event_type,
         event.workspace_id, target.id, event.subject_type, event.subject_id, event.payload,
         'failed', 'Webhook retry window expired', GREATEST(job.attempts, 1),
         false, 'retry_window_expired', NOW()
       FROM webhook_delivery_jobs job
       JOIN webhook_outbox_events event ON event.id = job.event_id
       JOIN workspaces workspace ON workspace.id = event.workspace_id
       LEFT JOIN targets target ON target.id = event.target_id
       WHERE event.id = ANY($1::text[])
         AND event.event_type <> 'workspace.deleted.v1'
         AND job.status NOT IN ('succeeded', 'failed', 'superseded', 'cancelled')`,
      [eventIds]
    );
    await client.query(
      `UPDATE webhook_delivery_jobs
       SET status = 'failed',
           terminal_reason = 'retry_window_expired',
           lease_owner = NULL,
           lease_expires_at = NULL,
           snapshot_secret_ciphertext = NULL,
           snapshot_secret_key_id = NULL,
           updated_at = NOW()
       WHERE event_id = ANY($1::text[])
         AND status NOT IN ('succeeded', 'failed', 'superseded', 'cancelled')`,
      [eventIds]
    );
    const result = await client.query(
      'DELETE FROM webhook_outbox_events WHERE id = ANY($1::text[])',
      [eventIds]
    );
    return result.rowCount ?? 0;
  });
}

export async function finishWebhookDeliveryJob(input: {
  job: ClaimedWebhookDelivery;
  status: 'succeeded' | 'failed' | 'retrying' | 'superseded' | 'cancelled' | 'paused';
  historyStatus?: WebhookHistoryStatus;
  responseStatus?: number;
  error?: string;
  durationMs?: number;
  nextAttemptAt?: string;
  terminalReason?: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
    `UPDATE webhook_delivery_jobs
     SET status = $2,
         attempts = CASE WHEN $2 = 'paused' THEN GREATEST(attempts - 1, 0) ELSE attempts END,
         next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
         lease_owner = NULL,
         lease_expires_at = NULL,
         terminal_reason = $4,
         snapshot_secret_ciphertext = CASE WHEN $2 IN ('succeeded', 'failed', 'superseded', 'cancelled')
           THEN NULL ELSE snapshot_secret_ciphertext END,
         snapshot_secret_key_id = CASE WHEN $2 IN ('succeeded', 'failed', 'superseded', 'cancelled')
           THEN NULL ELSE snapshot_secret_key_id END,
         updated_at = NOW()
     WHERE id = $1`,
    [input.job.jobId, input.status, input.nextAttemptAt || null, input.terminalReason || null]
  );
    if (!input.historyStatus) return;
    const shouldPersistHistory = input.job.eventType !== 'workspace.deleted.v1';
    if (shouldPersistHistory) {
      await client.query(
    `INSERT INTO webhook_history (
       id, subscription_id, event_id, event_type, workspace_id, target_id,
       subject_type, subject_id, payload, status, response_status, error, duration_ms,
       attempt_number, will_retry, next_attempt_at, terminal_reason, sent_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
       $14, $15, $16, $17, NOW())`,
    [
      randomUUID(),
      input.job.subscriptionId,
      input.job.eventId,
      input.job.eventType,
      input.job.workspaceId,
      input.job.eventType === 'target.deleted.v1' ? null : input.job.targetId || null,
      input.job.subjectType,
      input.job.subjectId,
      JSON.stringify(input.job.payload),
      input.historyStatus,
      input.responseStatus ?? null,
      input.error || null,
      input.durationMs ?? null,
      input.job.attempts,
      input.status === 'retrying',
      input.nextAttemptAt || null,
      input.terminalReason || null
    ]
      );
    }
    if (['succeeded', 'failed', 'superseded', 'cancelled'].includes(input.status)) {
      await client.query(
      `DELETE FROM webhook_outbox_events event
       WHERE event.id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM webhook_delivery_jobs job
           WHERE job.event_id = event.id
             AND job.status NOT IN ('succeeded', 'failed', 'superseded', 'cancelled')
         )`,
        [input.job.eventId]
      );
    }
  });
}

export async function pauseIssueWebhookJobs(
  queryable: Queryable,
  issueId: string,
  lifecycleVersion: number
): Promise<void> {
  await queryable.query(
    `WITH changed AS (
       UPDATE webhook_delivery_jobs job
       SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       FROM webhook_outbox_events event
       WHERE event.id = job.event_id
         AND event.subject_type = 'issue'
         AND event.subject_id = $1
         AND event.event_type IN ('issue.created.v1', 'issue.reopened.v1')
         AND (event.payload->'data'->>'lifecycleVersion')::int = $2
         AND job.status IN ('pending', 'retrying')
       RETURNING job.*, event.event_type, event.workspace_id, event.target_id,
         event.subject_type, event.subject_id, event.payload
     )
     INSERT INTO webhook_history (
       id, subscription_id, event_id, event_type, workspace_id, target_id,
       subject_type, subject_id, payload, status, attempt_number, will_retry,
       terminal_reason, sent_at
     )
     SELECT gen_random_uuid()::text, subscription_id, event_id, event_type,
       workspace_id, target_id, subject_type, subject_id, payload, 'paused',
       attempts, false, 'issue_recovering', NOW()
     FROM changed`,
    [issueId, lifecycleVersion]
  );
}

export async function resumeIssueWebhookJobs(
  queryable: Queryable,
  issueId: string,
  lifecycleVersion: number
): Promise<void> {
  await queryable.query(
    `UPDATE webhook_delivery_jobs job
     SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW()
     FROM webhook_outbox_events event
     WHERE event.id = job.event_id
       AND event.subject_type = 'issue'
       AND event.subject_id = $1
       AND (event.payload->'data'->>'lifecycleVersion')::int = $2
       AND job.status = 'paused'`,
    [issueId, lifecycleVersion]
  );
}

export async function supersedeOlderIssueWebhookJobs(
  queryable: Queryable,
  issueId: string,
  lifecycleVersion: number
): Promise<void> {
  await queryable.query(
    `WITH changed AS (
       UPDATE webhook_delivery_jobs job
       SET status = 'superseded',
           terminal_reason = 'issue_lifecycle_advanced',
           lease_owner = NULL,
           lease_expires_at = NULL,
           snapshot_secret_ciphertext = NULL,
           snapshot_secret_key_id = NULL,
           updated_at = NOW()
       FROM webhook_outbox_events event
       WHERE event.id = job.event_id
         AND event.subject_type = 'issue'
         AND event.subject_id = $1
         AND (event.payload->'data'->>'lifecycleVersion')::int < $2
         AND job.status IN ('pending', 'retrying', 'paused')
       RETURNING job.*, event.event_type, event.workspace_id, event.target_id,
         event.subject_type, event.subject_id, event.payload
     )
     INSERT INTO webhook_history (
       id, subscription_id, event_id, event_type, workspace_id, target_id,
       subject_type, subject_id, payload, status, attempt_number, will_retry,
       terminal_reason, sent_at
     )
     SELECT gen_random_uuid()::text, subscription_id, event_id, event_type,
       workspace_id, target_id, subject_type, subject_id, payload, 'superseded',
       attempts, false, 'issue_lifecycle_advanced', NOW()
     FROM changed`,
    [issueId, lifecycleVersion]
  );
  await queryable.query(
    `DELETE FROM webhook_outbox_events event
     WHERE event.subject_type = 'issue'
       AND event.subject_id = $1
       AND (event.payload->'data'->>'lifecycleVersion')::int < $2
       AND NOT EXISTS (
         SELECT 1
         FROM webhook_delivery_jobs job
         WHERE job.event_id = event.id
           AND job.status NOT IN ('succeeded', 'failed', 'superseded', 'cancelled')
       )`,
    [issueId, lifecycleVersion]
  );
}
