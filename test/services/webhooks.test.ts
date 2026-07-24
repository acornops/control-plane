import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  webhooks,
  type WebhookEventInput
} from '../../src/services/webhooks.js';
import { repo } from '../../src/store/repository.js';
import type { WebhookSubscription } from '../../src/types/domain.js';

afterEach(() => {
  mock.restoreAll();
});

function subscription(id: string): WebhookSubscription {
  return {
    id,
    workspaceId: 'ws-1',
    targetId: 'cluster-1',
    name: id,
    url: `https://example.com/${id}`,
    eventTypes: ['run.completed.v1'],
    enabled: true,
    secretCiphertext: 'encrypted-secret',
    secretKeyId: 'default',
    createdBy: 'user-1',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z'
  };
}

const input: WebhookEventInput = {
  type: 'run.completed.v1',
  workspaceId: 'ws-1',
  clusterId: 'cluster-1',
  targetId: 'cluster-1',
  targetType: 'kubernetes',
  subject: { type: 'run', id: 'run-1' },
  occurredAt: '2026-05-06T00:00:00.000Z',
  data: { result: 'ok' }
};

describe('webhooks.prepare', () => {
  it('loads subscriptions with the requested workspace, target, and event type', async () => {
    const expectedSubscriptions = [subscription('sub-1')];
    const calls: unknown[] = [];
    mock.method(repo, 'listMatchingWebhookSubscriptions', async (params) => {
      calls.push(params);
      return expectedSubscriptions;
    });

    assert.deepEqual(await webhooks.prepare(input), {
      input,
      subscriptions: expectedSubscriptions
    });
    assert.deepEqual(calls, [{
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      eventType: 'run.completed.v1'
    }]);
  });
});

describe('durable webhook enqueue', () => {
  it('enqueues normal events in the Postgres outbox', async () => {
    const calls: unknown[] = [];
    mock.method(repo, 'enqueueWebhookOutboxEvent', async (...args) => {
      calls.push(args);
      return 'evt-1';
    });

    assert.equal(await webhooks.enqueue(input), 'evt-1');
    assert.deepEqual(calls, [[input]]);
  });

  it('captures prepared recipients without making a network request', async () => {
    const recipients = [subscription('sub-1'), subscription('sub-2')];
    const calls: unknown[] = [];
    mock.method(repo, 'enqueueWebhookOutboxEvent', async (...args) => {
      calls.push(args);
      return 'evt-1';
    });

    webhooks.emitPrepared({ input, subscriptions: recipients });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [[
      { ...input, snapshotRecipients: true },
      undefined,
      recipients
    ]]);
  });

  it('preserves one durable event for fan-out and retries', async () => {
    let enqueueCount = 0;
    mock.method(repo, 'enqueueWebhookOutboxEvent', async () => {
      enqueueCount += 1;
      return 'evt-stable';
    });

    const eventId = await webhooks.enqueue(input);

    assert.equal(eventId, 'evt-stable');
    assert.equal(enqueueCount, 1);
  });
});

describe('webhooks target scope validation', () => {
  it('rejects target-scoped events without an explicit target type', async () => {
    await assert.rejects(
      () => webhooks.prepare({
        type: 'run.completed.v1',
        workspaceId: 'ws-1',
        clusterId: 'cluster-1',
        targetId: 'cluster-1',
        subject: { type: 'run', id: 'run-1' }
      }),
      /targetId and targetType/
    );
  });

  it('rejects non-Kubernetes target type when clusterId is present', async () => {
    await assert.rejects(
      () => webhooks.prepare({
        type: 'run.completed.v1',
        workspaceId: 'ws-1',
        clusterId: 'cluster-1',
        targetId: 'cluster-1',
        targetType: 'virtual_machine',
        subject: { type: 'run', id: 'run-1' }
      }),
      /targetType=kubernetes/
    );
  });
});
