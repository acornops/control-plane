import {
  ExternalWebhookRouteConnection,
  WebhookHistory,
  WebhookHistoryStatus,
  WebhookSubscription
} from '../types/domain.js';
import { toIso } from './repository-mappers.js';

export interface WebhookSubscriptionRow {
  id: string;
  workspace_id: string;
  target_id: string | null;
  name: string;
  url: string;
  event_types: string[] | null;
  enabled: boolean;
  secret_ciphertext: string;
  secret_key_id: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface WebhookHistoryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  workspace_id: string;
  target_id: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  status: WebhookHistoryStatus;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  attempt_number: number | string;
  will_retry: boolean;
  next_attempt_at: Date | string | null;
  terminal_reason: string | null;
  sent_at: Date | string;
}

export interface ExternalWebhookRouteConnectionRow {
  external_integration_user_link_id: string;
  integration_client_id: string;
  provider: string;
  external_user_id: string;
  delivery_url: string;
  connected_at: Date | string;
  last_synced_at: Date | string;
}

export function mapWebhookSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id || undefined,
    name: row.name,
    url: row.url,
    eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
    enabled: Boolean(row.enabled),
    secretCiphertext: row.secret_ciphertext,
    secretKeyId: row.secret_key_id,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapExternalWebhookRouteConnection(row: ExternalWebhookRouteConnectionRow): ExternalWebhookRouteConnection {
  return {
    externalIntegrationUserLinkId: row.external_integration_user_link_id,
    integrationClientId: row.integration_client_id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    deliveryUrl: row.delivery_url,
    connectedAt: toIso(row.connected_at)!,
    lastSyncedAt: toIso(row.last_synced_at)!
  };
}

export function mapWebhookHistory(row: WebhookHistoryRow): WebhookHistory {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    workspaceId: row.workspace_id,
    targetId: row.target_id || undefined,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload || {},
    status: row.status,
    responseStatus: row.response_status ?? undefined,
    error: row.error || undefined,
    durationMs: row.duration_ms ?? undefined,
    attemptNumber: Number(row.attempt_number ?? 1),
    willRetry: row.will_retry === true,
    nextAttemptAt: toIso(row.next_attempt_at),
    terminalReason: row.terminal_reason || undefined,
    sentAt: toIso(row.sent_at)!
  };
}
