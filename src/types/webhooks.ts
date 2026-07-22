export type WebhookHistoryStatus =
  'success' | 'failed' | 'paused' | 'superseded' | 'cancelled';

export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  targetId?: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  secretCiphertext: string;
  secretKeyId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

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
