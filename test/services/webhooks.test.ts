import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { webhookDeliveryClient } from '../../src/services/webhook-delivery.js';
import {
  webhooks,
  type PreparedWebhookDispatch,
  type WebhookEventInput
} from '../../src/services/webhooks.js';
import { repo } from '../../src/store/repository.js';
import type { WebhookSubscription } from '../../src/types/domain.js';
import { encryptWebhookSecret, signWebhookPayload } from '../../src/utils/crypto.js';

function createSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    workspaceId: 'ws-1',
    targetId: 'cluster-1',
    name: 'primary',
    url: 'https://example.com/webhook',
    eventTypes: ['run.completed.v1'],
    enabled: true,
    secretCiphertext: encryptWebhookSecret('whsec_test_secret'),
    secretKeyId: 'default',
    createdBy: 'user-1',
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...overrides
  };
}
function once<T>(label: string, timeoutMs = 1_000): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((innerResolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    resolvePromise = (value) => {
      clearTimeout(timeout);
      innerResolve(value);
    };
  });

  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) {
        throw new Error(`${label} resolver was not initialized`);
      }
      resolvePromise(value);
    }
  };
}

const originalDeliver = webhookDeliveryClient.deliver;
const originalListMatchingWebhookSubscriptions = repo.listMatchingWebhookSubscriptions;
const originalInsertWebhookHistory = repo.insertWebhookHistory;
const originalWebhookEmit = webhooks.emit;
afterEach(() => {
  webhookDeliveryClient.deliver = originalDeliver;
  repo.listMatchingWebhookSubscriptions = originalListMatchingWebhookSubscriptions;
  repo.insertWebhookHistory = originalInsertWebhookHistory;
  webhooks.emit = originalWebhookEmit;
});

describe('webhooks.prepare', () => {
  it('loads subscriptions with the requested workspace, target, and event type', async () => {
    const expectedSubscriptions = [createSubscription()];
    let receivedParams:
      | {
          workspaceId: string;
          targetId?: string;
          eventType: string;
        }
      | undefined;
    repo.listMatchingWebhookSubscriptions = async (params) => {
      receivedParams = params;
      return expectedSubscriptions;
    };
    const input: WebhookEventInput = {
      type: 'run.completed.v1',
      workspaceId: 'ws-1',
      clusterId: 'cluster-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      subject: { type: 'run', id: 'run-1' }
    };
    const prepared = await webhooks.prepare(input);
    assert.deepEqual(receivedParams, {
      workspaceId: 'ws-1',
      targetId: 'cluster-1',
      eventType: 'run.completed.v1'
    });
    assert.deepEqual(prepared, {
      input,
      subscriptions: expectedSubscriptions
    });
  });
});

describe('webhooks.emitPrepared', () => {
  it('skips delivery work when there are no subscriptions', async () => {
    let called = false;

    webhookDeliveryClient.deliver = async () => {
      called = true;
      return { status: 204, ok: true };
    };
    repo.insertWebhookHistory = async () => {
      called = true;
      throw new Error('should not write history');
    };
    webhooks.emitPrepared({
      input: {
        type: 'run.completed.v1',
        workspaceId: 'ws-1',
        subject: { type: 'run', id: 'run-1' }
      },
      subscriptions: []
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(called, false);
  });

  it('signs successful deliveries and records success history', async () => {
    const subscription = createSubscription();
    const historyCall = once<Parameters<typeof repo.insertWebhookHistory>[0]>('success history write');
    let deliveryCall: Parameters<typeof webhookDeliveryClient.deliver>[0] | undefined;

    webhookDeliveryClient.deliver = async (input) => {
      deliveryCall = input;
      return { status: 202, ok: true };
    };
    repo.insertWebhookHistory = async (input) => {
      historyCall.resolve(input);
      return {
        id: 'hist-1',
        sentAt: '2026-05-06T00:00:01.000Z',
        ...input
      } as never;
    };
    const prepared: PreparedWebhookDispatch = {
      input: {
        type: 'run.completed.v1',
        workspaceId: 'ws-1',
        clusterId: 'cluster-1',
        targetId: 'cluster-1',
        targetType: 'kubernetes',
        occurredAt: '2026-05-06T00:00:00.000Z',
        subject: { type: 'run', id: 'run-1' },
        data: { result: 'ok' }
      },
      subscriptions: [subscription]
    };

    webhooks.emitPrepared(prepared);
    const history = await historyCall.promise;

    assert.ok(deliveryCall);
    assert.equal(deliveryCall.url, subscription.url);
    assert.equal(deliveryCall.method, 'POST');
    assert.equal(deliveryCall.timeoutMs, 5000);
    const headers = new Headers(deliveryCall.headers);
    const body = deliveryCall.body;
    const timestamp = headers.get('AcornOps-Timestamp');
    assert.ok(timestamp);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('AcornOps-Event-Type'), 'run.completed.v1');
    assert.equal(headers.get('AcornOps-Event-Id'), history.eventId);
    assert.equal(
      headers.get('AcornOps-Signature'),
      `v1=${signWebhookPayload('whsec_test_secret', timestamp, body)}`
    );
    assert.equal(history.status, 'success');
    assert.equal(history.targetId, 'cluster-1');
    assert.equal(history.responseStatus, 202);
    assert.equal(history.error, undefined);
    assert.equal(history.payload.id, history.eventId);
    assert.equal(history.payload.type, 'run.completed.v1');
    assert.equal(history.payload.clusterId, 'cluster-1');
    assert.equal(history.payload.targetId, 'cluster-1');
    assert.equal(history.payload.targetType, 'kubernetes');
    assert.deepEqual(history.payload.subject, { type: 'run', id: 'run-1' });
    assert.deepEqual(history.payload.data, { result: 'ok' });
  });

  it('reuses one event payload across all matching subscriptions', async () => {
    const histories: Array<Parameters<typeof repo.insertWebhookHistory>[0]> = [];
    const fetchedEventIds: string[] = [];
    const historyCall = once<void>('fan-out history writes');

    webhookDeliveryClient.deliver = async (input) => {
      const headers = new Headers(input.headers);
      const eventId = headers.get('AcornOps-Event-Id');
      assert.ok(eventId);
      fetchedEventIds.push(eventId);
      return { status: 204, ok: true };
    };
    repo.insertWebhookHistory = async (input) => {
      histories.push(input);
      if (histories.length === 2) {
        historyCall.resolve();
      }
      return {
        id: `hist-${histories.length}`,
        sentAt: '2026-05-06T00:00:01.000Z',
        ...input
      } as never;
    };

    webhooks.emitPrepared({
      input: {
        type: 'run.completed.v1',
        workspaceId: 'ws-1',
        subject: { type: 'run', id: 'run-1' }
      },
      subscriptions: [createSubscription({ id: 'sub-1' }), createSubscription({ id: 'sub-2', url: 'https://example.com/backup' })]
    });

    await historyCall.promise;

    assert.equal(histories.length, 2);
    assert.equal(fetchedEventIds.length, 2);
    assert.equal(new Set(fetchedEventIds).size, 1);
    assert.equal(new Set(histories.map((history) => history.eventId)).size, 1);
    assert.deepEqual(fetchedEventIds, histories.map((history) => history.eventId));
    assert.equal(histories[0]?.eventId, histories[1]?.eventId);
  });

  it('records failed deliveries when the endpoint returns a non-success status', async () => {
    const historyCall = once<Parameters<typeof repo.insertWebhookHistory>[0]>('failed delivery history write');

    webhookDeliveryClient.deliver = async () => ({ status: 503, ok: false });
    repo.insertWebhookHistory = async (input) => {
      historyCall.resolve(input);
      return {
        id: 'hist-2',
        sentAt: '2026-05-06T00:00:01.000Z',
        ...input
      } as never;
    };

    webhooks.emitPrepared({
      input: {
        type: 'run.failed.v1',
        workspaceId: 'ws-1',
        subject: { type: 'run', id: 'run-1' },
        data: { error: 'boom' }
      },
      subscriptions: [createSubscription({ eventTypes: ['run.failed.v1'] })]
    });

    const history = await historyCall.promise;

    assert.equal(history.status, 'failed');
    assert.equal(history.responseStatus, 503);
    assert.equal(history.error, 'Webhook endpoint returned HTTP 503');
  });

  it('records fetch failures with the thrown error message', async () => {
    const historyCall = once<Parameters<typeof repo.insertWebhookHistory>[0]>('fetch error history write');

    webhookDeliveryClient.deliver = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    repo.insertWebhookHistory = async (input) => {
      historyCall.resolve(input);
      return {
        id: 'hist-3',
        sentAt: '2026-05-06T00:00:01.000Z',
        ...input
      } as never;
    };

    webhooks.emitPrepared({
      input: {
        type: 'run.failed.v1',
        workspaceId: 'ws-1',
        subject: { type: 'run', id: 'run-1' }
      },
      subscriptions: [createSubscription({ eventTypes: ['run.failed.v1'] })]
    });

    const history = await historyCall.promise;

    assert.equal(history.status, 'failed');
    assert.equal(history.responseStatus, undefined);
    assert.equal(history.error, 'connect ECONNREFUSED');
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
