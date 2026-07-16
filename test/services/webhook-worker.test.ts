import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { webhookDeliveryClient } from '../../src/services/webhook-delivery.js';
import { runWebhookDeliverySweep } from '../../src/services/webhook-worker.js';
import { repo } from '../../src/store/repository.js';
import type { ClaimedWebhookDelivery } from '../../src/store/repository-webhook-outbox.js';
import type { TargetIssue } from '../../src/types/target-issues.js';
import { encryptWebhookSecret } from '../../src/utils/crypto.js';

afterEach(() => {
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
  });
  mock.method(repo, 'getWebhookQueueMetrics', async () => ({
    pending: 0,
    retrying: 0,
    paused: 0,
    oldestAgeSeconds: 0
  }));
  return finishes;
}

describe('durable webhook worker', () => {
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
