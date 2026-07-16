import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  connectExternalWebhookRoute,
  getExternalWebhookRouteStatus
} from '../src/controllers/external-webhook-route-controller.js';
import { repo } from '../src/store/repository.js';
import type { ExternalRouteWebhookSubscription } from '../src/store/repository-webhooks.js';

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

function createExternalIntegrationRequest(input: { body?: unknown; query?: Record<string, unknown> } = {}) {
  return {
    auth: {
      userId: 'user-1',
      credential: {
        type: 'external_integration',
        linkId: 'link-1',
        integrationId: 'mattermost-eng',
        provider: 'mattermost',
        externalUserId: 'mm-user-1'
      }
    },
    body: input.body || {},
    query: input.query || {}
  };
}

function webhook(input: Partial<ExternalRouteWebhookSubscription>): ExternalRouteWebhookSubscription {
  return {
    id: input.id || 'webhook-1',
    workspaceId: input.workspaceId || 'workspace-1',
    workspaceName: input.workspaceName || 'Platform',
    workspaceRole: input.workspaceRole || 'admin',
    name: input.name || 'Ops route',
    url: input.url || 'https://bot.example.com/acornops/webhooks/routes/route-token',
    eventTypes: input.eventTypes || ['run.failed.v1'],
    enabled: input.enabled ?? true,
    secretCiphertext: input.secretCiphertext || 'ciphertext',
    secretKeyId: input.secretKeyId || 'v1',
    createdBy: input.createdBy || 'user-1',
    createdAt: input.createdAt || '2026-07-08T00:00:00.000Z',
    updatedAt: input.updatedAt || '2026-07-08T00:00:00.000Z',
    targetId: input.targetId
  };
}

describe('external webhook route controller', () => {
  afterEach(() => mock.restoreAll());

  it('requires a linked external integration credential for connect', async () => {
    const res = createResponse();
    await connectExternalWebhookRoute({
      auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
      body: { deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: { code: 'UNAUTHORIZED', message: 'Linked external integration required', retryable: false }
    });
  });

  it('connect rotates and returns secrets only for currently manageable matching subscriptions', async () => {
    const manageable = webhook({ id: 'webhook-admin', workspaceRole: 'admin' });
    const viewer = webhook({ id: 'webhook-viewer', workspaceId: 'workspace-2', workspaceName: 'Read Only', workspaceRole: 'viewer' });
    const rotatedIds: string[] = [];
    const auditMetadata: Array<Record<string, unknown>> = [];
    mock.method(repo, 'listWebhookSubscriptionsForExternalRoute', async () => [manageable, viewer]);
    mock.method(repo, 'connectExternalWebhookRoute', async (input: {
      rotations: Array<{ webhookId: string }>;
    }) => {
      rotatedIds.push(...input.rotations.map((rotation) => rotation.webhookId));
      return {
        connection: {
          externalIntegrationUserLinkId: 'link-1',
          integrationClientId: 'mattermost-eng',
          provider: 'mattermost',
          externalUserId: 'mm-user-1',
          deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token',
          connectedAt: '2026-07-08T01:00:00.000Z',
          lastSyncedAt: '2026-07-08T01:00:00.000Z'
        },
        subscriptions: [{ ...manageable, updatedAt: '2026-07-08T01:00:00.000Z' }]
      };
    });
    mock.method(repo, 'insertWorkspaceAuditEvent', async (input: { metadata?: Record<string, unknown> }) => {
      auditMetadata.push(input.metadata || {});
      return null;
    });

    const res = createResponse();
    await connectExternalWebhookRoute(createExternalIntegrationRequest({
      body: { deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token' }
    }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(rotatedIds, ['webhook-admin']);
    const body = res.body as { status: string; subscriptions: Array<Record<string, unknown>> };
    assert.equal(body.status, 'connected');
    assert.equal(body.subscriptions.length, 1);
    assert.equal(body.subscriptions[0].webhookId, 'webhook-admin');
    assert.match(String(body.subscriptions[0].signingSecret), /^whsec_/);
    assert.equal(auditMetadata.length, 1);
    assert.equal(Object.hasOwn(auditMetadata[0], 'deliveryUrl'), false);
    assert.match(String(auditMetadata[0].deliveryUrlHash), /^[a-f0-9]{64}$/);
  });

  it('status returns live subscription state without signing secrets', async () => {
    mock.method(repo, 'listWebhookSubscriptionsForExternalRoute', async () => [
      webhook({ id: 'webhook-1', enabled: false, workspaceRole: 'owner' })
    ]);
    mock.method(repo, 'touchExternalWebhookRouteConnection', async () => ({
      externalIntegrationUserLinkId: 'link-1',
      integrationClientId: 'mattermost-eng',
      provider: 'mattermost',
      externalUserId: 'mm-user-1',
      deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token',
      connectedAt: '2026-07-08T01:00:00.000Z',
      lastSyncedAt: '2026-07-08T01:05:00.000Z'
    }));

    const res = createResponse();
    await getExternalWebhookRouteStatus(createExternalIntegrationRequest({
      query: { deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token' }
    }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    const body = res.body as { status: string; subscriptions: Array<Record<string, unknown>> };
    assert.equal(body.status, 'connected');
    assert.equal(body.subscriptions[0].status, 'disabled');
    assert.equal(Object.hasOwn(body.subscriptions[0], 'signingSecret'), false);
  });

  it('status reports configured when matching subscriptions exist before first connect', async () => {
    mock.method(repo, 'listWebhookSubscriptionsForExternalRoute', async () => [webhook({ workspaceRole: 'admin' })]);
    mock.method(repo, 'touchExternalWebhookRouteConnection', async () => null);

    const res = createResponse();
    await getExternalWebhookRouteStatus(createExternalIntegrationRequest({
      query: { deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token' }
    }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, 'configured');
  });

  it('connect reports unconfigured without creating connection state when there are no manageable subscriptions', async () => {
    let upserted = false;
    mock.method(repo, 'listWebhookSubscriptionsForExternalRoute', async () => []);
    mock.method(repo, 'connectExternalWebhookRoute', async () => {
      upserted = true;
    });

    const res = createResponse();
    await connectExternalWebhookRoute(createExternalIntegrationRequest({
      body: { deliveryUrl: 'https://bot.example.com/acornops/webhooks/routes/route-token' }
    }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, 'unconfigured');
    assert.equal(upserted, false);
  });
});
