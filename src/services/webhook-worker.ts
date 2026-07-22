import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  incrementWebhookDeliveryTerminal,
  incrementWebhookLeaseRecovery,
  recordWebhookDeliveryAttempt,
  setWebhookQueueMetrics
} from '../metrics-webhook-delivery.js';
import { repo } from '../store/repository.js';
import type { ClaimedWebhookDelivery } from '../store/repository-webhook-outbox.js';
import { decryptWebhookSecret, signWebhookPayload } from '../utils/crypto.js';
import { WebhookDeliveryPolicyError, webhookDeliveryClient } from './webhook-delivery.js';

function isIssueEvent(job: ClaimedWebhookDelivery): boolean {
  return job.subjectType === 'issue' && job.eventType.startsWith('issue.');
}

function lifecycleVersion(job: ClaimedWebhookDelivery): number {
  const data = job.payload.data;
  if (!data || typeof data !== 'object') return 0;
  return Number((data as Record<string, unknown>).lifecycleVersion) || 0;
}

async function issueDeliveryState(job: ClaimedWebhookDelivery): Promise<'deliver' | 'pause' | 'supersede'> {
  if (!isIssueEvent(job)) return 'deliver';
  const issue = await repo.getTargetIssue(job.workspaceId, job.subjectId);
  if (!issue || issue.lifecycleVersion > lifecycleVersion(job)) return 'supersede';
  if (issue.lifecycleVersion < lifecycleVersion(job)) return 'supersede';
  if (job.eventType === 'issue.resolved.v1') {
    return issue.status === 'resolved' ? 'deliver' : 'supersede';
  }
  if (issue.status === 'recovering') return 'pause';
  return issue.status === 'active' ? 'deliver' : 'supersede';
}

function subscriptionStillMatches(job: ClaimedWebhookDelivery): boolean {
  if (!job.url || !job.secretCiphertext) return false;
  if (job.recipientSnapshot) return true;
  if (!job.subscriptionEnabled || !job.subscriptionEventTypes.includes(job.eventType)) return false;
  return !job.subscriptionTargetId || job.subscriptionTargetId === job.targetId;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(value?: string): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 6 * 60 * 60 * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.min(timestamp - Date.now(), 6 * 60 * 60 * 1000));
}

function nextRetryAt(job: ClaimedWebhookDelivery, retryAfter?: string): string {
  const explicit = retryAfterMs(retryAfter);
  const capMs = 6 * 60 * 60 * 1000;
  const exponential = Math.min(60_000 * (3 ** Math.max(0, job.attempts - 1)), capMs);
  const delay = explicit ?? Math.floor(Math.random() * Math.max(1, exponential));
  return new Date(Date.now() + delay).toISOString();
}

function canRetry(job: ClaimedWebhookDelivery): boolean {
  const ageMs = Date.now() - Date.parse(job.createdAt);
  return job.attempts < config.WEBHOOK_MAX_ATTEMPTS &&
    ageMs < config.WEBHOOK_MAX_RETRY_AGE_SECONDS * 1000;
}

async function processWebhookDelivery(job: ClaimedWebhookDelivery): Promise<void> {
  const issueState = await issueDeliveryState(job);
  if (issueState === 'pause') {
    await repo.finishWebhookDeliveryJob({
      job,
      status: 'paused',
      historyStatus: 'paused',
      terminalReason: 'issue_recovering'
    });
    return;
  }
  if (issueState === 'supersede') {
    const accepted = await repo.finishWebhookDeliveryJob({
      job,
      status: 'superseded',
      historyStatus: 'superseded',
      terminalReason: 'issue_lifecycle_advanced'
    });
    if (accepted) incrementWebhookDeliveryTerminal('superseded');
    return;
  }
  if (!subscriptionStillMatches(job)) {
    const accepted = await repo.finishWebhookDeliveryJob({
      job,
      status: 'cancelled',
      historyStatus: 'cancelled',
      terminalReason: 'subscription_unavailable'
    });
    if (accepted) incrementWebhookDeliveryTerminal('cancelled');
    return;
  }

  const startedAt = Date.now();
  const rawBody = JSON.stringify(job.payload);
  let secret: string;
  try {
    secret = decryptWebhookSecret(job.secretCiphertext!);
  } catch {
    const accepted = await repo.finishWebhookDeliveryJob({
      job,
      status: 'failed',
      historyStatus: 'failed',
      error: 'Webhook signing configuration is unavailable',
      durationMs: Date.now() - startedAt,
      terminalReason: 'signing_configuration'
    });
    if (accepted) incrementWebhookDeliveryTerminal('failed');
    return;
  }
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    const response = await webhookDeliveryClient.deliver({
      url: job.url!,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'AcornOps-Event-Id': job.eventId,
        'AcornOps-Event-Type': job.eventType,
        'AcornOps-Timestamp': timestamp,
        'AcornOps-Signature': `v1=${signature}`
      },
      body: rawBody,
      timeoutMs: config.WEBHOOK_DELIVERY_TIMEOUT_MS
    });
    if (response.ok) {
      recordWebhookDeliveryAttempt('succeeded', Date.now() - startedAt);
      const accepted = await repo.finishWebhookDeliveryJob({
        job,
        status: 'succeeded',
        historyStatus: 'success',
        responseStatus: response.status,
        durationMs: Date.now() - startedAt
      });
      if (accepted) incrementWebhookDeliveryTerminal('succeeded');
      return;
    }
    const retry = retryableStatus(response.status) && canRetry(job);
    recordWebhookDeliveryAttempt(retry ? 'retrying' : 'failed', Date.now() - startedAt);
    const accepted = await repo.finishWebhookDeliveryJob({
      job,
      status: retry ? 'retrying' : 'failed',
      historyStatus: 'failed',
      responseStatus: response.status,
      error: `Webhook endpoint returned HTTP ${response.status}`,
      durationMs: Date.now() - startedAt,
      nextAttemptAt: retry ? nextRetryAt(job, response.retryAfter) : undefined,
      terminalReason: retry ? undefined : 'http_terminal'
    });
    if (!retry && accepted) incrementWebhookDeliveryTerminal('failed');
  } catch (err) {
    const policyFailure = err instanceof WebhookDeliveryPolicyError;
    const retry = !policyFailure && canRetry(job);
    recordWebhookDeliveryAttempt(retry ? 'retrying' : 'failed', Date.now() - startedAt);
    const accepted = await repo.finishWebhookDeliveryJob({
      job,
      status: retry ? 'retrying' : 'failed',
      historyStatus: 'failed',
      error: policyFailure ? 'Webhook destination was rejected by delivery policy' : 'Webhook delivery network error',
      durationMs: Date.now() - startedAt,
      nextAttemptAt: retry ? nextRetryAt(job) : undefined,
      terminalReason: retry ? undefined : policyFailure ? 'delivery_policy' : 'attempts_exhausted'
    });
    if (!retry && accepted) incrementWebhookDeliveryTerminal('failed');
  }
}

function origin(job: ClaimedWebhookDelivery): string {
  try {
    return job.url ? new URL(job.url).origin : 'missing';
  } catch {
    return 'invalid';
  }
}

async function processWithLimits(jobs: ClaimedWebhookDelivery[]): Promise<void> {
  const queues = new Map<string, ClaimedWebhookDelivery[]>();
  for (const job of jobs) {
    const key = origin(job);
    const queue = queues.get(key) || [];
    queue.push(job);
    queues.set(key, queue);
  }
  const originQueues = [...queues.values()];
  let firstOrigin = 0;
  while (originQueues.some((queue) => queue.length > 0)) {
    const batch: ClaimedWebhookDelivery[] = [];
    for (let offset = 0; offset < originQueues.length; offset += 1) {
      const queue = originQueues[(firstOrigin + offset) % originQueues.length];
      const remaining = config.WEBHOOK_WORKER_CONCURRENCY - batch.length;
      if (remaining <= 0) break;
      batch.push(...queue.splice(
        0,
        Math.min(config.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY, remaining)
      ));
      if (batch.length >= config.WEBHOOK_WORKER_CONCURRENCY) break;
    }
    firstOrigin = (firstOrigin + 1) % Math.max(1, originQueues.length);
    await Promise.all(batch.map(processWebhookDelivery));
  }
}

export async function runWebhookDeliverySweep(): Promise<void> {
  if (!config.WEBHOOK_WORKER_ENABLED) {
    try {
      setWebhookQueueMetrics(await repo.getWebhookQueueMetrics());
    } catch (err) {
      logger.warn({ err }, 'Webhook queue metrics refresh failed while delivery claims are disabled');
    }
    return;
  }
  const leaseOwner = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
  const serialOriginWaves = Math.ceil(
    config.WEBHOOK_WORKER_BATCH_SIZE / config.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY
  );
  const leaseSeconds = Math.max(
    30,
    Math.ceil((serialOriginWaves * config.WEBHOOK_DELIVERY_TIMEOUT_MS * 1.5 + 5_000) / 1000)
  );
  try {
    await repo.purgeExpiredWebhookOutboxEvents();
    const jobs = await repo.claimWebhookDeliveryJobs(
      config.WEBHOOK_WORKER_BATCH_SIZE,
      leaseOwner,
      leaseSeconds
    );
    for (const job of jobs) {
      if (job.leaseRecovered) incrementWebhookLeaseRecovery();
    }
    await processWithLimits(jobs);
    setWebhookQueueMetrics(await repo.getWebhookQueueMetrics());
  } catch (err) {
    logger.warn({ err }, 'Webhook delivery sweep failed');
  }
}
