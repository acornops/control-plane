import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import type { ExternalWebhookRouteConnection } from '../types/external-webhooks.js';
import { Role, WebhookHistory, WebhookHistoryStatus, WebhookSubscription } from '../types/domain.js';
import {
  ExternalWebhookRouteConnectionRow,
  WebhookHistoryRow,
  WebhookSubscriptionRow,
  mapExternalWebhookRouteConnection,
  mapWebhookHistory,
  mapWebhookSubscription
} from './repository-webhook-mappers.js';
import { withTransaction } from './repository-transaction.js';

export interface ExternalRouteWebhookSubscription extends WebhookSubscription {
  workspaceName: string;
  workspaceRole: Role;
}

interface ExternalRouteWebhookSubscriptionRow extends WebhookSubscriptionRow {
  workspace_name: string;
  workspace_role: Role;
}

function mapExternalRouteWebhookSubscription(row: ExternalRouteWebhookSubscriptionRow): ExternalRouteWebhookSubscription {
  return {
    ...mapWebhookSubscription(row),
    workspaceName: row.workspace_name || row.workspace_id,
    workspaceRole: row.workspace_role
  };
}

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

export async function listWebhookSubscriptionsForExternalRoute(input: {
    acornopsUserId: string;
    deliveryUrl: string;
  }): Promise<ExternalRouteWebhookSubscription[]> {
    const result = await db.query(
      `SELECT
         s.*,
         w.name AS workspace_name,
         m.role AS workspace_role
       FROM webhook_subscriptions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN workspace_memberships m
         ON m.workspace_id = s.workspace_id
        AND m.user_id = $1
       WHERE s.created_by = $1
         AND s.url = $2
       ORDER BY w.name ASC, s.created_at ASC, s.id ASC`,
      [input.acornopsUserId, input.deliveryUrl]
    );
    return result.rows.map((row) => mapExternalRouteWebhookSubscription(row as ExternalRouteWebhookSubscriptionRow));
  }

export async function connectExternalWebhookRoute(input: {
    externalIntegrationUserLinkId: string;
    integrationClientId: string;
    provider: string;
    externalUserId: string;
    acornopsUserId: string;
    deliveryUrl: string;
    allowedRoleKeys: string[];
    rotations: Array<{
      workspaceId: string;
      webhookId: string;
      secretCiphertext: string;
      secretKeyId: string;
    }>;
  }): Promise<{
    connection: ExternalWebhookRouteConnection;
    subscriptions: ExternalRouteWebhookSubscription[];
  }> {
    return withTransaction(async (client) => {
      const webhookIds = input.rotations.map((rotation) => rotation.webhookId);
      const eligible = await client.query(
        `SELECT
           s.*,
           w.name AS workspace_name,
           m.role AS workspace_role
         FROM webhook_subscriptions s
         JOIN workspaces w ON w.id = s.workspace_id
         JOIN workspace_memberships m
           ON m.workspace_id = s.workspace_id
          AND m.user_id = $1
         WHERE s.created_by = $1
           AND s.url = $2
           AND m.role = ANY($3::text[])
           AND s.id = ANY($4::text[])
         ORDER BY w.name ASC, s.created_at ASC, s.id ASC
         FOR UPDATE OF s, m`,
        [input.acornopsUserId, input.deliveryUrl, input.allowedRoleKeys, webhookIds]
      );
      if (eligible.rows.length !== input.rotations.length) {
        throw new Error('Webhook route authorization changed during secret rotation');
      }
      const eligibleById = new Map(
        eligible.rows.map((row) => [
          String(row.id),
          mapExternalRouteWebhookSubscription(row as ExternalRouteWebhookSubscriptionRow)
        ])
      );
      const rotated: WebhookSubscription[] = [];
      for (const rotation of input.rotations) {
        const eligibleSubscription = eligibleById.get(rotation.webhookId);
        if (!eligibleSubscription || eligibleSubscription.workspaceId !== rotation.workspaceId) {
          throw new Error('Webhook route authorization changed during secret rotation');
        }
        const result = await client.query(
          `UPDATE webhook_subscriptions
           SET secret_ciphertext = $3,
               secret_key_id = $4,
               updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2
           RETURNING *`,
          [rotation.workspaceId, rotation.webhookId, rotation.secretCiphertext, rotation.secretKeyId]
        );
        if (!result.rowCount) {
          throw new Error(`Webhook subscription ${rotation.webhookId} disappeared during secret rotation`);
        }
        rotated.push(mapWebhookSubscription(result.rows[0] as WebhookSubscriptionRow));
      }
      const connectionResult = await client.query(
        `INSERT INTO external_webhook_route_connections (
           external_integration_user_link_id, integration_client_id, provider, external_user_id,
           delivery_url, connected_at, last_synced_at
         ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (external_integration_user_link_id, delivery_url)
         DO UPDATE SET
           integration_client_id = EXCLUDED.integration_client_id,
           provider = EXCLUDED.provider,
           external_user_id = EXCLUDED.external_user_id,
           connected_at = NOW(),
           last_synced_at = NOW()
         RETURNING *`,
        [
          input.externalIntegrationUserLinkId,
          input.integrationClientId,
          input.provider,
          input.externalUserId,
          input.deliveryUrl
        ]
      );
      const subscriptions = rotated.map((subscription) => {
        const eligibleSubscription = eligibleById.get(subscription.id)!;
        return {
          ...eligibleSubscription,
          ...subscription,
          workspaceName: eligibleSubscription.workspaceName,
          workspaceRole: eligibleSubscription.workspaceRole
        };
      });
      return {
        connection: mapExternalWebhookRouteConnection(
          connectionResult.rows[0] as ExternalWebhookRouteConnectionRow
        ),
        subscriptions
      };
    });
  }

export async function touchExternalWebhookRouteConnection(input: {
    externalIntegrationUserLinkId: string;
    integrationClientId: string;
    provider: string;
    externalUserId: string;
    deliveryUrl: string;
  }): Promise<ExternalWebhookRouteConnection | null> {
    const result = await db.query(
      `UPDATE external_webhook_route_connections
       SET last_synced_at = NOW()
       WHERE external_integration_user_link_id = $1
         AND integration_client_id = $2
         AND provider = $3
         AND external_user_id = $4
         AND delivery_url = $5
       RETURNING *`,
      [
        input.externalIntegrationUserLinkId,
        input.integrationClientId,
        input.provider,
        input.externalUserId,
        input.deliveryUrl
      ]
    );
    if (!result.rowCount) return null;
    return mapExternalWebhookRouteConnection(result.rows[0] as ExternalWebhookRouteConnectionRow);
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
