import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { listWebhookHistory } from '../src/controllers/webhooks-controller.js';
import { repo } from '../src/store/repository.js';
import type { WebhookHistory, WebhookSubscription } from '../src/types/domain.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetWebhookSubscription = repo.getWebhookSubscription;
const originalListWebhookHistory = repo.listWebhookHistory;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getWebhookSubscription = originalGetWebhookSubscription;
  repo.listWebhookHistory = originalListWebhookHistory;
});

function createResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

function createRequest() {
  return {
    auth: { userId: 'user-1' },
    params: { workspaceId: 'workspace-1', webhookId: 'webhook-1' },
    query: {}
  };
}

describe('webhook history authorization', () => {
  it('denies webhook delivery history to workspace viewers', async () => {
    let historyRead = false;
    repo.getWorkspaceRole = async () => 'viewer';
    repo.getWebhookSubscription = async () => {
      throw new Error('viewer should be denied before webhook lookup');
    };
    repo.listWebhookHistory = async () => {
      historyRead = true;
      return [];
    };
    const res = createResponse();

    await listWebhookHistory(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.equal(historyRead, false);
    assert.deepEqual(res.body, {
      error: {
        code: 'FORBIDDEN',
        message: 'Only workspace roles with webhook management capability can read webhook delivery history',
        retryable: false
      }
    });
  });

  it('allows webhook delivery history to workspace admins', async () => {
    const webhook: WebhookSubscription = {
      id: 'webhook-1',
      workspaceId: 'workspace-1',
      name: 'Deploy Hook',
      url: 'https://example.com/webhook',
      eventTypes: ['run.completed.v1'],
      enabled: true,
      secretCiphertext: 'ciphertext',
      secretKeyId: 'v1',
      createdBy: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const history: WebhookHistory = {
      id: 'history-1',
      subscriptionId: 'webhook-1',
      eventId: 'event-1',
      eventType: 'run.completed.v1',
      workspaceId: 'workspace-1',
      subjectType: 'run',
      subjectId: 'run-1',
      payload: { data: { result: 'ok' } },
      status: 'success',
      responseStatus: 202,
      durationMs: 12,
      attemptNumber: 1,
      willRetry: false,
      sentAt: '2026-01-01T00:00:01.000Z'
    };
    repo.getWorkspaceRole = async () => 'admin';
    repo.getWebhookSubscription = async () => webhook;
    repo.listWebhookHistory = async () => [history];
    const res = createResponse();

    await listWebhookHistory(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      items: [{
        id: 'history-1',
        subscriptionId: 'webhook-1',
        eventId: 'event-1',
        eventType: 'run.completed.v1',
        workspaceId: 'workspace-1',
        targetId: null,
        subjectType: 'run',
        subjectId: 'run-1',
        payload: { data: { result: 'ok' } },
        status: 'success',
        responseStatus: 202,
        error: null,
        durationMs: 12,
        attemptNumber: 1,
        willRetry: false,
        nextAttemptAt: null,
        terminalReason: null,
        sentAt: '2026-01-01T00:00:01.000Z'
      }]
    });
  });
});
