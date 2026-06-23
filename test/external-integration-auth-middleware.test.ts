import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  EXTERNAL_INTEGRATION_USER_ID_HEADER,
  requireActor
} from '../src/auth/middleware.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';

const requireCombinedActor = requireActor(['user', 'externalIntegration']);
const DEV_EXTERNAL_INTEGRATION_TOKEN = 'dev_external_integration_client_token';

function createResponse() {
  return {
    statusCode: 200,
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

function createExternalIntegrationRequest(input: { token?: string; externalUserId?: string }) {
  const headers = new Map<string, string>();
  if (input.token) headers.set('authorization', `Bearer ${input.token}`);
  if (input.externalUserId) headers.set(EXTERNAL_INTEGRATION_USER_ID_HEADER, input.externalUserId);
  return {
    cookies: {},
    header(name: string) {
      return headers.get(name.toLowerCase());
    }
  } as { cookies: Record<string, string>; auth?: unknown; header(name: string): string | undefined };
}

describe("requireActor(['user', 'externalIntegration']) middleware", () => {
  afterEach(() => mock.restoreAll());

  it('keeps browser sessions on the session credential path when both credentials are present', async () => {
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: Date.now() - 60_000,
      lastSeenAt: Date.now() - 60_000,
      absoluteExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      idleExpiresAt: Date.now() + 60_000
    }));
    mock.method(redis, 'setex', async () => 'OK');
    mock.method(repo, 'resolveExternalIntegrationUserLink', async () => {
      throw new Error('external integration lookup should not run when a session is present');
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' },
      header: (name: string) => {
        const headers = new Map<string, string>([
          ['authorization', `Bearer ${DEV_EXTERNAL_INTEGRATION_TOKEN}`],
          [EXTERNAL_INTEGRATION_USER_ID_HEADER, 'slack-user-1']
        ]);
        return headers.get(name.toLowerCase());
      }
    } as { cookies: Record<string, string>; auth?: unknown; header(name: string): string | undefined };
    const res = createResponse();
    let nextCalled = false;

    await requireCombinedActor(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.auth, {
      userId: 'user-1',
      credential: { type: 'session', sessionId: 'session-1' }
    });
  });

  it('sets an external integration credential for a linked external user', async () => {
    mock.method(repo, 'resolveExternalIntegrationUserLink', async () => ({
      status: 'linked' as const,
      user: {
        id: 'user-1',
        email: 'user@example.com',
        displayName: 'User'
      },
      link: {
        integrationClientId: 'dev-client',
        provider: 'external',
        clientDisplayName: 'Development external integration',
        externalUserId: 'slack-user-1',
        linkedAt: '2026-06-01T00:00:00.000Z',
        lastAuthenticatedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z'
      }
    }));

    const req = createExternalIntegrationRequest({
      token: DEV_EXTERNAL_INTEGRATION_TOKEN,
      externalUserId: 'slack-user-1'
    });
    const res = createResponse();
    let nextCalled = false;

    await requireCombinedActor(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.auth, {
      userId: 'user-1',
      credential: {
	        type: 'external_integration',
	        integrationClientId: 'dev-client',
	        provider: 'external',
	        externalUserId: 'slack-user-1'
	      }
    });
  });

  it('rejects external integration requests without the service token', async () => {
    const req = createExternalIntegrationRequest({ externalUserId: 'slack-user-1' });
    const res = createResponse();
    let nextCalled = false;

    await requireCombinedActor(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'User session or linked external integration required',
        retryable: false
      }
    });
  });

  it('rejects external integration requests without a bounded external user id header', async () => {
    const req = createExternalIntegrationRequest({
      token: DEV_EXTERNAL_INTEGRATION_TOKEN,
      externalUserId: ' '.repeat(4)
    });
    const res = createResponse();
    let nextCalled = false;

    await requireCombinedActor(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Linked external integration user id required',
        retryable: false
      }
    });
  });

  it('rejects external integration requests for unlinked users', async () => {
    mock.method(repo, 'resolveExternalIntegrationUserLink', async () => null);

    const req = createExternalIntegrationRequest({
      token: DEV_EXTERNAL_INTEGRATION_TOKEN,
      externalUserId: 'slack-user-1'
    });
    const res = createResponse();
    let nextCalled = false;

    await requireCombinedActor(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Linked external integration account required',
        retryable: false
      }
    });
  });

  it('returns a useful message for external-integration-only actor policy without a service token', async () => {
    const req = createExternalIntegrationRequest({ externalUserId: 'slack-user-1' });
    const res = createResponse();
    let nextCalled = false;

    await requireActor(['externalIntegration'])(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Linked external integration required',
        retryable: false
      }
    });
  });
});
