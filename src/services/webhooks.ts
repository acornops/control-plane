import { logger } from '../logger.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, type Run, type WebhookSubscription } from '../types/domain.js';
import type { WebhookEventType } from '../types/contracts.js';
import { recordRunStatusChangedActivity } from './target-chat-activity-events.js';
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
  dedupeKey?: string;
}

export interface PreparedWebhookDispatch {
  input: WebhookEventInput;
  subscriptions: WebhookSubscription[];
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

async function prepareDispatch(input: WebhookEventInput): Promise<PreparedWebhookDispatch> {
  assertTargetScope(input);
  const subscriptions = await repo.listMatchingWebhookSubscriptions({
    workspaceId: input.workspaceId,
    targetId: input.targetId || input.clusterId,
    eventType: input.type
  });
  return { input, subscriptions };
}

async function enqueue(input: WebhookEventInput): Promise<string | null> {
  assertTargetScope(input);
  return repo.enqueueWebhookOutboxEvent(input);
}

export const webhooks = {
  emit(input: WebhookEventInput): void {
    void enqueue(input).catch((err) => {
      logger.warn({ err, type: input.type, workspaceId: input.workspaceId }, 'Webhook enqueue failed');
    });
  },

  enqueue,

  async prepare(input: WebhookEventInput): Promise<PreparedWebhookDispatch> {
    return prepareDispatch(input);
  },

  emitPrepared(prepared: PreparedWebhookDispatch): void {
    void repo.enqueueWebhookOutboxEvent(
      { ...prepared.input, snapshotRecipients: true },
      undefined,
      prepared.subscriptions
    ).catch((err) => {
      logger.warn(
        { err, type: prepared.input.type, workspaceId: prepared.input.workspaceId },
        'Prepared webhook enqueue failed'
      );
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
    objectType: 'run',
    objectId: run.id,
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

  void recordRunStatusChangedActivity(previous, next);

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
