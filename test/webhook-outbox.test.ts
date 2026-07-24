import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  finishWebhookDeliveryJob,
  type ClaimedWebhookDelivery
} from '../src/store/repository-webhook-outbox.js';

afterEach(() => {
  mock.restoreAll();
});

function claimedJob(): ClaimedWebhookDelivery {
  return {
    jobId: 'job-1',
    eventId: 'evt_1',
    eventType: 'issue.created.v1',
    occurredAt: '2026-07-22T00:00:00.000Z',
    workspaceId: 'workspace-1',
    targetId: 'target-1',
    targetType: 'kubernetes',
    subjectType: 'issue',
    subjectId: 'issue-1',
    payload: { id: 'evt_1' },
    subscriptionId: 'subscription-1',
    leaseOwner: 'control-plane-1:lease-1',
    attempts: 1,
    createdAt: '2026-07-22T00:00:00.000Z',
    url: 'https://bot.example.com/webhook',
    secretCiphertext: 'ciphertext',
    secretKeyId: 'default',
    recipientSnapshot: false,
    subscriptionEnabled: true,
    subscriptionEventTypes: ['issue.created.v1'],
    leaseRecovered: false
  };
}

describe('webhook outbox lease fencing', () => {
  it('does not persist a stale worker result after another replica reclaims the lease', async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes('UPDATE webhook_delivery_jobs')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: null, rows: [] };
      },
      release() {}
    };
    mock.method(db, 'connect', async () => client as never);

    await finishWebhookDeliveryJob({
      job: claimedJob(),
      status: 'succeeded',
      historyStatus: 'success',
      responseStatus: 204
    });

    const update = statements.find((sql) => sql.includes('UPDATE webhook_delivery_jobs')) || '';
    assert.match(update, /status = 'processing'/);
    assert.match(update, /lease_owner = \$5/);
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO webhook_history')), false);
    assert.deepEqual(statements.slice(-1), ['COMMIT']);
  });
});
