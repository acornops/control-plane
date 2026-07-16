export interface ExternalWebhookRouteConnection {
  externalIntegrationUserLinkId: string;
  integrationClientId: string;
  provider: string;
  externalUserId: string;
  deliveryUrl: string;
  connectedAt: string;
  lastSyncedAt: string;
}

export type WebhookHistoryStatus = 'success' | 'failed' | 'paused' | 'superseded' | 'cancelled';

export interface WebhookHistory {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  workspaceId: string;
  targetId?: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  status: WebhookHistoryStatus;
  responseStatus?: number;
  error?: string;
  durationMs?: number;
  attemptNumber: number;
  willRetry: boolean;
  nextAttemptAt?: string;
  terminalReason?: string;
  sentAt: string;
}
