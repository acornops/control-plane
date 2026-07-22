import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../../src/config.js';
import { webhookDeliveryClient } from '../../src/services/webhook-delivery.js';
import { runWebhookDeliverySweep } from '../../src/services/webhook-worker.js';
import { repo } from '../../src/store/repository.js';
import type { ClaimedWebhookDelivery } from '../../src/store/repository-webhook-outbox.js';
import type { TargetIssue } from '../../src/types/target-issues.js';
import { encryptWebhookSecret } from '../../src/utils/crypto.js';

const mutableConfig = config as typeof config & {
  WEBHOOK_WORKER_ENABLED: boolean;
  WEBHOOK_WORKER_CONCURRENCY: number;
  WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY: number;
};
const originalWebhookWorkerEnabled = config.WEBHOOK_WORKER_ENABLED;
const originalWebhookWorkerConcurrency = config.WEBHOOK_WORKER_CONCURRENCY;
const originalWebhookWorkerPerOriginConcurrency = config.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY;

afterEach(() => {
  mutableConfig.WEBHOOK_WORKER_ENABLED = originalWebhookWorkerEnabled;
  mutableConfig.WEBHOOK_WORKER_CONCURRENCY = originalWebhookWorkerConcurrency;
  mutableConfig.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY = originalWebhookWorkerPerOriginConcurrency;
  mock.restoreAll();
});

function job(overrides: Partial<ClaimedWebhookDelivery> = {}): ClaimedWebhookDelivery {
  return {
    jobId: 'job-1',
    eventId: 'evt-stable',
    eventType: 'issue.created.v1',
    occurredAt: '2026-05-06T00:00:00.000Z',
    workspaceId: 'ws-1',
    targetId: 'target-1',
    targetType: 'kubernetes',
    subjectType: 'issue',
    subjectId: 'issue-1',
    payload: {
      id: 'evt-stable',
      type: 'issue.created.v1',
      occurredAt: '2026-05-06T00:00:00.000Z',
      workspaceId: 'ws-1',
      subject: { type: 'issue', id: 'issue-1' },
      data: { lifecycleVersion: 1, status: 'active' }
    },
    subscriptionId: 'sub-1',
    leaseOwner: 'cp-test:lease-1',
    attempts: 1,
    createdAt: new Date().toISOString(),
    url: 'https://example.com/webhook',
    secretCiphertext: encryptWebhookSecret('whsec_worker_test'),
    secretKeyId: 'default',
    recipientSnapshot: false,
    subscriptionEnabled: true,
    subscriptionEventTypes: ['issue.created.v1'],
    leaseRecovered: false,
    ...overrides
  };
}

function issue(status: TargetIssue['status'], lifecycleVersion = 1): TargetIssue {
  return {
    id: 'issue-1',
    workspaceId: 'ws-1',
    targetId: 'target-1',
    targetType: 'kubernetes',
    fingerprint: 'fingerprint',
    issueType: 'kubernetes_pod_unhealthy',
    status,
    severity: 'critical',
    title: 'Pod unhealthy',
    summary: 'Pod is unhealthy',
    firstSeenAt: '2026-05-06T00:00:00.000Z',
    lastSeenAt: '2026-05-06T00:00:00.000Z',
    lastObservedSnapshotAt: '2026-05-06T00:00:00.000Z',
    occurrenceCount: 1,
    reopenedCount: 0,
    cleanSnapshotCount: 0,
    lifecycleVersion,
    latestEvidence: {},
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z'
  };
}

function arrangeSweep(claimedJob: ClaimedWebhookDelivery) {
  const finishes: Array<Parameters<typeof repo.finishWebhookDeliveryJob>[0]> = [];
  mock.method(repo, 'purgeExpiredWebhookOutboxEvents', async () => 0);
  mock.method(repo, 'claimWebhookDeliveryJobs', async () => [claimedJob]);
  mock.method(repo, 'finishWebhookDeliveryJob', async (input) => {
    finishes.push(input);
    return true;
  });
  mock.method(repo, 'getWebhookQueueMetrics', async () => ({
    pending: 0,
    processing: 0,
    retrying: 0,
    paused: 0,
    oldestAgeSeconds: 0
  }));
  return finishes;
}

describe('durable webhook worker', () => {
  it('refreshes queue metrics without claiming jobs when delivery is disabled', async () => {
    mutableConfig.WEBHOOK_WORKER_ENABLED = false;
    let metricsReads = 0;
    let claims = 0;
    mock.method(repo, 'getWebhookQueueMetrics', async () => {
      metricsReads += 1;
      return { pending: 3, processing: 1, retrying: 2, paused: 4, oldestAgeSeconds: 60 };
    });
    mock.method(repo, 'claimWebhookDeliveryJobs', async () => {
      claims += 1;
      return [];
    });

    await runWebhookDeliverySweep();

    assert.equal(metricsReads, 1);
    assert.equal(claims, 0);
  });

  it('leases a full same-origin batch for longer than its worst-case timeout waves', async () => {
    let leaseSeconds = 0;
    mock.method(repo, 'purgeExpiredWebhookOutboxEvents', async () => 0);
    mock.method(repo, 'claimWebhookDeliveryJobs', async (_limit, _owner, lease) => {
      leaseSeconds = lease;
      return [];
    });
    mock.method(repo, 'getWebhookQueueMetrics', async () => ({
      pending: 0, processing: 0, retrying: 0, paused: 0, oldestAgeSeconds: 0
    }));

    await runWebhookDeliverySweep();

    const sameOriginWaves = Math.ceil(config.WEBHOOK_WORKER_BATCH_SIZE / config.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY);
    assert.ok(leaseSeconds * 1000 > sameOriginWaves * config.WEBHOOK_DELIVERY_TIMEOUT_MS);
  });

  it('caps per-origin lease throughput at the lower global concurrency', async () => {
    mutableConfig.WEBHOOK_WORKER_CONCURRENCY = 1;
    mutableConfig.WEBHOOK_WORKER_PER_ORIGIN_CONCURRENCY = 4;
    let leaseSeconds = 0;
    mock.method(repo, 'purgeExpiredWebhookOutboxEvents', async () => 0);
    mock.method(repo, 'claimWebhookDeliveryJobs', async (_limit, _owner, lease) => {
      leaseSeconds = lease;
      return [];
    });
    mock.method(repo, 'getWebhookQueueMetrics', async () => ({
      pending: 0, processing: 0, retrying: 0, paused: 0, oldestAgeSeconds: 0
    }));

    await runWebhookDeliverySweep();

    const sameOriginWaves = config.WEBHOOK_WORKER_BATCH_SIZE;
    assert.ok(leaseSeconds * 1000 > sameOriginWaves * config.WEBHOOK_DELIVERY_TIMEOUT_MS);
  });

  it('delivers the immutable event ID and records success', async () => {
    const claimed = job();
    const finishes = arrangeSweep(claimed);
    let request: Parameters<typeof webhookDeliveryClient.deliver>[0] | undefined;
    mock.method(repo, 'getTargetIssue', async () => issue('active'));
    mock.method(webhookDeliveryClient, 'deliver', async (input) => {
      request = input;
      return { status: 202, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(new Headers(request?.headers).get('AcornOps-Event-Id'), 'evt-stable');
    assert.equal(JSON.parse(String(request?.body)).id, 'evt-stable');
    assert.equal(finishes[0]?.status, 'succeeded');
    assert.equal(finishes[0]?.historyStatus, 'success');
  });

  it('pauses an active notification while its issue is recovering without sending it', async () => {
    const finishes = arrangeSweep(job());
    let delivered = false;
    mock.method(repo, 'getTargetIssue', async () => issue('recovering'));
    mock.method(webhookDeliveryClient, 'deliver', async () => {
      delivered = true;
      return { status: 204, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(delivered, false);
    assert.equal(finishes[0]?.status, 'paused');
    assert.equal(finishes[0]?.historyStatus, 'paused');
    assert.equal(finishes[0]?.terminalReason, 'issue_recovering');
  });

  it('supersedes a stale lifecycle version before the network attempt', async () => {
    const finishes = arrangeSweep(job());
    let delivered = false;
    mock.method(repo, 'getTargetIssue', async () => issue('resolved', 2));
    mock.method(webhookDeliveryClient, 'deliver', async () => {
      delivered = true;
      return { status: 204, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(delivered, false);
    assert.equal(finishes[0]?.status, 'superseded');
    assert.equal(finishes[0]?.terminalReason, 'issue_lifecycle_advanced');
  });

  it('schedules retryable responses and preserves the same event body', async () => {
    const claimed = job();
    const finishes = arrangeSweep(claimed);
    mock.method(repo, 'getTargetIssue', async () => issue('active'));
    mock.method(webhookDeliveryClient, 'deliver', async () => ({
      status: 503,
      ok: false,
      retryAfter: '60'
    }));

    await runWebhookDeliverySweep();

    assert.equal(finishes[0]?.status, 'retrying');
    assert.equal(finishes[0]?.historyStatus, 'failed');
    assert.equal(finishes[0]?.responseStatus, 503);
    assert.ok(Date.parse(finishes[0]?.nextAttemptAt || '') > Date.now());
    assert.equal(claimed.payload.id, 'evt-stable');
  });

  it('cancels a job when the current subscription no longer selects the event', async () => {
    const finishes = arrangeSweep(job({ subscriptionEventTypes: ['run.completed.v1'] }));
    let delivered = false;
    mock.method(repo, 'getTargetIssue', async () => issue('active'));
    mock.method(webhookDeliveryClient, 'deliver', async () => {
      delivered = true;
      return { status: 204, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(delivered, false);
    assert.equal(finishes[0]?.status, 'cancelled');
    assert.equal(finishes[0]?.terminalReason, 'subscription_unavailable');
  });

  it('cancels a job when the current subscription selects no event types', async () => {
    const finishes = arrangeSweep(job({ subscriptionEventTypes: [] }));
    let delivered = false;
    mock.method(repo, 'getTargetIssue', async () => issue('active'));
    mock.method(webhookDeliveryClient, 'deliver', async () => {
      delivered = true;
      return { status: 204, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(delivered, false);
    assert.equal(finishes[0]?.status, 'cancelled');
    assert.equal(finishes[0]?.terminalReason, 'subscription_unavailable');
  });

  it('delivers deletion snapshot jobs even after the live subscription row is gone', async () => {
    const claimed = job({
      eventType: 'target.deleted.v1',
      subjectType: 'target',
      recipientSnapshot: true,
      subscriptionEnabled: true,
      subscriptionEventTypes: [],
      targetId: undefined,
      payload: {
        id: 'evt-stable',
        type: 'target.deleted.v1',
        occurredAt: '2026-05-06T00:00:00.000Z',
        workspaceId: 'ws-1',
        subject: { type: 'target', id: 'target-1' },
        data: { targetId: 'target-1', targetType: 'kubernetes' }
      }
    });
    const finishes = arrangeSweep(claimed);
    let delivered = false;
    mock.method(webhookDeliveryClient, 'deliver', async () => {
      delivered = true;
      return { status: 204, ok: true };
    });

    await runWebhookDeliverySweep();

    assert.equal(delivered, true);
    assert.equal(finishes[0]?.status, 'succeeded');
  });
});
