import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, type Run, type WebhookSubscription } from '../types/domain.js';
import type { WebhookEventType } from '../types/contracts.js';
import { decryptWebhookSecret, signWebhookPayload } from '../utils/crypto.js';
import { webhookDeliveryClient } from './webhook-delivery.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';

interface WebhookSubject {
  type: string;
  id: string;
}

export interface WebhookEventInput {
  type: WebhookEventType;
  workspaceId: string;
  clusterId?: string;
  targetId?: string;
  targetType?: string;
  subject: WebhookSubject;
  data?: Record<string, unknown>;
  occurredAt?: string;
}

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  occurredAt: string;
  workspaceId: string;
  clusterId?: string;
  targetId?: string;
  targetType?: string;
  subject: WebhookSubject;
  data: Record<string, unknown>;
}

export interface PreparedWebhookDispatch {
  input: WebhookEventInput;
  subscriptions: WebhookSubscription[];
}

function createEventId(): string {
  return `evt_${randomUUID()}`;
}

function assertTargetScope(input: WebhookEventInput): void {
  const targetId = input.targetId || input.clusterId;
  if (input.clusterId && input.targetId && input.clusterId !== input.targetId) {
    throw new Error('Webhook event clusterId and targetId must match for Kubernetes targets');
  }
  if ((targetId || input.targetType) && !(targetId && input.targetType)) {
    throw new Error('Webhook target-scoped events require both targetId and targetType');
  }
  if (input.clusterId && input.targetType !== KUBERNETES_TARGET_TYPE) {
    throw new Error('Webhook events with clusterId require targetType=kubernetes');
  }
}

function createPayload(input: WebhookEventInput): WebhookPayload {
  assertTargetScope(input);
  const targetId = input.targetId || input.clusterId;
  return {
    id: createEventId(),
    type: input.type,
    occurredAt: input.occurredAt || new Date().toISOString(),
    workspaceId: input.workspaceId,
    clusterId: input.clusterId,
    targetId,
    targetType: input.targetType,
    subject: input.subject,
    data: input.data || {}
  };
}

function toHistoryPayload(payload: WebhookPayload): Record<string, unknown> {
  return {
    id: payload.id,
    type: payload.type,
    occurredAt: payload.occurredAt,
    workspaceId: payload.workspaceId,
    ...(payload.clusterId ? { clusterId: payload.clusterId } : {}),
    ...(payload.targetId ? { targetId: payload.targetId } : {}),
    ...(payload.targetType ? { targetType: payload.targetType } : {}),
    subject: payload.subject,
    data: payload.data
  };
}

async function deliverToSubscription(subscription: WebhookSubscription, payload: WebhookPayload): Promise<void> {
  const startedAt = Date.now();
  const rawBody = JSON.stringify(toHistoryPayload(payload));
  let responseStatus: number | undefined;
  let status: 'success' | 'failed' = 'failed';
  let error: string | undefined;

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = decryptWebhookSecret(subscription.secretCiphertext);
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    const response = await webhookDeliveryClient.deliver({
      url: subscription.url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'AcornOps-Event-Id': payload.id,
        'AcornOps-Event-Type': payload.type,
        'AcornOps-Timestamp': timestamp,
        'AcornOps-Signature': `v1=${signature}`
      },
      body: rawBody,
      timeoutMs: config.WEBHOOK_DELIVERY_TIMEOUT_MS
    });
    responseStatus = response.status;
    status = response.ok ? 'success' : 'failed';
    if (!response.ok) {
      error = `Webhook endpoint returned HTTP ${response.status}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Webhook delivery failed';
  }

  const durationMs = Date.now() - startedAt;
  try {
    await repo.insertWebhookHistory({
      subscriptionId: subscription.id,
      eventId: payload.id,
      eventType: payload.type,
      workspaceId: payload.workspaceId,
      targetId: payload.targetId || payload.clusterId,
      subjectType: payload.subject.type,
      subjectId: payload.subject.id,
      payload: toHistoryPayload(payload),
      status,
      responseStatus,
      error,
      durationMs
    });
  } catch (historyErr) {
    logger.warn(
      {
        err: historyErr,
        eventId: payload.id,
        subscriptionId: subscription.id
      },
      'Failed recording webhook delivery history'
    );
  }
}

async function prepareDispatch(input: WebhookEventInput): Promise<PreparedWebhookDispatch> {
  assertTargetScope(input);
  const subscriptions = await repo.listMatchingWebhookSubscriptions({
    workspaceId: input.workspaceId,
    targetId: input.targetId || input.clusterId,
    eventType: input.type
  });
  return { input, subscriptions };
}

async function deliverPrepared(prepared: PreparedWebhookDispatch): Promise<void> {
  const { subscriptions } = prepared;
  if (subscriptions.length === 0) {
    return;
  }

  const payload = createPayload(prepared.input);
  await Promise.all(subscriptions.map((subscription) => deliverToSubscription(subscription, payload)));
}

async function dispatch(input: WebhookEventInput): Promise<void> {
  const prepared = await prepareDispatch(input);
  await deliverPrepared(prepared);
}

export const webhooks = {
  emit(input: WebhookEventInput): void {
    queueMicrotask(() => {
      dispatch(input).catch((err) => {
        logger.warn({ err, type: input.type, workspaceId: input.workspaceId }, 'Webhook dispatch failed');
      });
    });
  },

  async prepare(input: WebhookEventInput): Promise<PreparedWebhookDispatch> {
    return prepareDispatch(input);
  },

  emitPrepared(prepared: PreparedWebhookDispatch): void {
    queueMicrotask(() => {
      deliverPrepared(prepared).catch((err) => {
        logger.warn(
          { err, type: prepared.input.type, workspaceId: prepared.input.workspaceId },
          'Webhook dispatch failed'
        );
      });
    });
  }
};

const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled']);

function recordRunLifecycleAudit(eventType: WebhookEventType, run: Run): void {
  void recordWorkspaceAuditEvent({
    workspaceId: run.workspaceId,
    category: 'run',
    eventType,
    operation: 'write',
    actorType: 'system',
    targetType: 'run',
    targetId: run.id,
    summary: `Run ${run.status}`,
    metadata: {
      sessionId: run.sessionId,
      messageId: run.messageId,
      targetId: run.targetId,
      targetType: run.targetType,
      status: run.status,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.errorCode ? { errorCode: run.errorCode } : {})
    }
  });
}

export function emitRunStatusTransition(previous: Run, next: Run | null): void {
  if (!next) {
    return;
  }

  if (previous.status !== 'running' && next.status === 'running' && !previous.startedAt) {
    webhooks.emit({
      type: 'run.started.v1',
      workspaceId: next.workspaceId,
      clusterId: next.targetType === KUBERNETES_TARGET_TYPE ? next.targetId : undefined,
      targetId: next.targetId,
      targetType: next.targetType,
      subject: { type: 'run', id: next.id },
      data: {
        sessionId: next.sessionId,
        messageId: next.messageId,
        status: next.status,
        startedAt: next.startedAt || null
      }
    });
    recordRunLifecycleAudit('run.started.v1', next);
  }

  if (!terminalRunStatuses.has(previous.status) && terminalRunStatuses.has(next.status)) {
    const eventType =
      next.status === 'completed'
        ? 'run.completed.v1'
        : next.status === 'failed'
          ? 'run.failed.v1'
          : 'run.cancelled.v1';
    webhooks.emit({
      type: eventType,
      workspaceId: next.workspaceId,
      clusterId: next.targetType === KUBERNETES_TARGET_TYPE ? next.targetId : undefined,
      targetId: next.targetId,
      targetType: next.targetType,
      subject: { type: 'run', id: next.id },
      data: {
        sessionId: next.sessionId,
        messageId: next.messageId,
        status: next.status,
        startedAt: next.startedAt || null,
        endedAt: next.endedAt || null,
        errorCode: next.errorCode || null,
        errorMessage: next.errorMessage || null,
        usage: next.usage || null
      }
    });
    recordRunLifecycleAudit(eventType, next);
  }
}
