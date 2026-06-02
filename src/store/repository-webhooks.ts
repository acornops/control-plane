import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { WebhookHistory, WebhookHistoryStatus, WebhookSubscription } from '../types/domain.js';
import {
  WebhookHistoryRow,
  WebhookSubscriptionRow,
  mapWebhookHistory,
  mapWebhookSubscription
} from './repository-webhook-mappers.js';
import { withTransaction } from './repository-transaction.js';

export async function createWebhookSubscription(input: {
    workspaceId: string;
    targetId?: string | null;
    name: string;
    url: string;
    eventTypes: string[];
    enabled: boolean;
    secretCiphertext: string;
    secretKeyId: string;
    createdBy: string;
  }): Promise<WebhookSubscription> {
    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO webhook_subscriptions (
         id, workspace_id, target_id, name, url, event_types, enabled,
         secret_ciphertext, secret_key_id, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [
        id,
        input.workspaceId,
        input.targetId || null,
        input.name,
        input.url,
        JSON.stringify(input.eventTypes),
        input.enabled,
        input.secretCiphertext,
        input.secretKeyId,
        input.createdBy
      ]
    );
    return mapWebhookSubscription(result.rows[0] as WebhookSubscriptionRow);
  }

export async function listWebhookSubscriptions(workspaceId: string): Promise<WebhookSubscription[]> {
    const result = await db.query(
      `SELECT *
       FROM webhook_subscriptions
       WHERE workspace_id = $1
       ORDER BY created_at DESC, id DESC`,
      [workspaceId]
    );
    return result.rows.map((row) => mapWebhookSubscription(row as WebhookSubscriptionRow));
  }

export async function getWebhookSubscription(workspaceId: string, webhookId: string): Promise<WebhookSubscription | null> {
    const result = await db.query(
      `SELECT *
       FROM webhook_subscriptions
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, webhookId]
    );
    if (!result.rowCount) return null;
    return mapWebhookSubscription(result.rows[0] as WebhookSubscriptionRow);
  }

export async function updateWebhookSubscription(
    workspaceId: string,
    webhookId: string,
    patch: {
      name?: string;
      url?: string;
      eventTypes?: string[];
      targetId?: string | null;
      enabled?: boolean;
    }
): Promise<WebhookSubscription | null> {
    const current = await getWebhookSubscription(workspaceId, webhookId);
    if (!current) return null;

    const result = await db.query(
      `UPDATE webhook_subscriptions
       SET name = $3,
           url = $4,
           event_types = $5::jsonb,
           target_id = $6,
           enabled = $7,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING *`,
      [
        workspaceId,
        webhookId,
        patch.name ?? current.name,
        patch.url ?? current.url,
        JSON.stringify(patch.eventTypes ?? current.eventTypes),
        Object.prototype.hasOwnProperty.call(patch, 'targetId') ? patch.targetId || null : current.targetId || null,
        patch.enabled ?? current.enabled
      ]
    );
    return mapWebhookSubscription(result.rows[0] as WebhookSubscriptionRow);
  }

export async function deleteWebhookSubscription(workspaceId: string, webhookId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const result = await client.query(
        'DELETE FROM webhook_subscriptions WHERE workspace_id = $1 AND id = $2',
        [workspaceId, webhookId]
      );
      if ((result.rowCount ?? 0) === 0) {
        return false;
      }
      await client.query('DELETE FROM webhook_history WHERE workspace_id = $1 AND subscription_id = $2', [
        workspaceId,
        webhookId
      ]);
      return true;
    });
  }

export async function listMatchingWebhookSubscriptions(params: {
    workspaceId: string;
    targetId?: string;
    eventType: string;
  }): Promise<WebhookSubscription[]> {
    const result = await db.query(
      `SELECT *
       FROM webhook_subscriptions
       WHERE workspace_id = $1
         AND enabled = true
         AND event_types ? $2
         AND (target_id IS NULL OR target_id = $3)
       ORDER BY created_at ASC`,
      [params.workspaceId, params.eventType, params.targetId || null]
    );
    return result.rows.map((row) => mapWebhookSubscription(row as WebhookSubscriptionRow));
  }

export async function insertWebhookHistory(input: {
    subscriptionId: string;
    eventId: string;
    eventType: string;
    workspaceId: string;
    targetId?: string | null;
    subjectType: string;
    subjectId: string;
    payload: Record<string, unknown>;
    status: WebhookHistoryStatus;
    responseStatus?: number;
    error?: string;
    durationMs?: number;
  }): Promise<WebhookHistory> {
    const result = await db.query(
      `INSERT INTO webhook_history (
         id, subscription_id, event_id, event_type, workspace_id, target_id,
         subject_type, subject_id, payload, status, response_status, error, duration_ms, sent_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.subscriptionId,
        input.eventId,
        input.eventType,
        input.workspaceId,
        input.targetId || null,
        input.subjectType,
        input.subjectId,
        JSON.stringify(input.payload),
        input.status,
        input.responseStatus ?? null,
        input.error || null,
        input.durationMs ?? null
      ]
    );
    return mapWebhookHistory(result.rows[0] as WebhookHistoryRow);
  }

export async function listWebhookHistory(
    workspaceId: string,
    webhookId: string,
    options?: { limit?: number }
): Promise<WebhookHistory[]> {
    const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
    const result = await db.query(
      `SELECT h.*
       FROM webhook_history h
       INNER JOIN webhook_subscriptions s ON s.id = h.subscription_id
       WHERE h.workspace_id = $1
         AND h.subscription_id = $2
         AND s.workspace_id = $1
       ORDER BY h.sent_at DESC, h.id DESC
       LIMIT $3`,
      [workspaceId, webhookId, limit]
    );
    return result.rows.map((row) => mapWebhookHistory(row as WebhookHistoryRow));
  }

export async function purgeOldWebhookHistory(retentionDays: number, limit = 1000): Promise<number> {
    const result = await db.query(
      `WITH candidate AS (
         SELECT id
         FROM webhook_history
         WHERE sent_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY sent_at ASC
         LIMIT $2
       )
       DELETE FROM webhook_history h
       USING candidate c
       WHERE h.id = c.id`,
      [Math.max(1, retentionDays), Math.max(1, Math.min(5000, limit))]
    );
    return result.rowCount ?? 0;
  }
