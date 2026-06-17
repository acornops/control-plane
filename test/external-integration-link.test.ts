import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createExternalIntegrationLink, hashExternalIntegrationLinkToken } from '../src/auth/external-integration-link.js';
import { requireExternalIntegrationServiceToken } from '../src/auth/middleware.js';
import {
  completeExternalIntegrationLinkRequest,
  createExternalIntegrationLinkRequest,
  resolveExternalIntegrationLink
} from '../src/controllers/external-integration-link-controller.js';
import { oidcLogin } from '../src/controllers/auth-controller.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import {
  completeExternalIntegrationLinkToken as completeExternalIntegrationLinkTokenRecord,
  createExternalIntegrationLinkToken as createExternalIntegrationLinkTokenRecord,
  externalIntegrationLinkTokenIsPending as externalIntegrationLinkTokenIsPendingRecord
} from '../src/store/repository-external-integration-links.js';
import { repo } from '../src/store/repository.js';

const mutableConfig = config as typeof config & {
  MANAGEMENT_CONSOLE_BASE_URL: string;
  EXTERNAL_INTEGRATION_SERVICE_TOKEN: string;
  OIDC_ISSUER_URL: string;
  OIDC_REDIRECT_URI: string;
  OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic' | 'client_secret_post' | 'none';
};

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    redirectUrl: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(url: string) {
      this.redirectUrl = url;
      return this;
    }
  };
}

function installOidcDiscovery(issuer: string): void {
  mock.method(globalThis, 'fetch', async (rawInput: string | URL | Request) => {
    const url = rawInput instanceof Request ? rawInput.url : String(rawInput);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200
      });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => {
  mock.restoreAll();
});

describe('external integration link contract', () => {
  it('creates a DB-backed link token and returns a console link', async () => {
    const originalConsoleBaseUrl = config.MANAGEMENT_CONSOLE_BASE_URL;
    try {
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = 'https://console.example.com';
      let stored: Record<string, unknown> | undefined;
      mock.method(repo, 'createExternalIntegrationLinkToken', async (input: Record<string, unknown>) => {
        stored = input;
      });

      const result = await createExternalIntegrationLink({
        externalUserId: 'user-1'
      });

      const link = new URL(result.linkUrl);
      const token = link.searchParams.get('token');
      assert.equal(link.origin, 'https://console.example.com');
      assert.equal(link.pathname, '/integrations/external-chat/link');
      assert.match(token || '', /^intlink_/);
      assert.equal(stored?.externalUserId, 'user-1');
      assert.equal(stored?.tokenHash, hashExternalIntegrationLinkToken(token || ''));
      assert.equal(String(stored?.tokenHash).includes(token || 'raw-token-never'), false);
    } finally {
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = originalConsoleBaseUrl;
    }
  });

  it('replaces existing pending tokens before storing a new link token', async () => {
    const expiresAt = new Date('2026-06-08T00:10:00.000Z');
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'release' });
      }
    };
    mock.method(db, 'connect', async () => client);

    await createExternalIntegrationLinkTokenRecord({
      externalUserId: 'user-1',
      tokenHash: 'hash-new',
      expiresAt
    });

    const advisoryLock = queries.find((query) => query.sql.includes('pg_advisory_xact_lock'));
    assert.deepEqual(advisoryLock?.params, ['user-1']);

    const invalidation = queries.find((query) => query.sql.includes('UPDATE external_integration_link_tokens'));
    assert.ok(invalidation?.sql.includes('invalidated_at = NOW()'));
    assert.ok(invalidation?.sql.includes('consumed_at IS NULL'));
    assert.ok(invalidation?.sql.includes('invalidated_at IS NULL'));
    assert.ok(invalidation?.sql.includes('expires_at > NOW()'));
    assert.deepEqual(invalidation?.params, ['user-1']);

    const insert = queries.find((query) => query.sql.includes('INSERT INTO external_integration_link_tokens'));
    assert.equal(insert?.params?.[1], 'hash-new');
    assert.equal(insert?.params?.[2], 'user-1');
    assert.equal(insert?.params?.[3], expiresAt);
  });

  it('does not treat invalidated link tokens as pending', async () => {
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      assert.ok(sql.includes('invalidated_at IS NULL'));
      assert.deepEqual(params, ['hash-old']);
      return { rows: [{ exists: false }], rowCount: 1 };
    });

    assert.equal(await externalIntegrationLinkTokenIsPendingRecord('hash-old'), false);
  });

  it('rejects invalidated link tokens during completion', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes('SELECT *')) {
          return {
            rows: [{
              id: 'token-1',
              token_hash: 'hash-old',
              external_user_id: 'user-1',
              created_at: new Date('2026-06-08T00:00:00.000Z'),
              expires_at: new Date(Date.now() + 60000),
              consumed_at: null,
              invalidated_at: new Date('2026-06-08T00:01:00.000Z')
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        queries.push({ sql: 'release' });
      }
    };
    mock.method(db, 'connect', async () => client);

    const completed = await completeExternalIntegrationLinkTokenRecord({
      tokenHash: 'hash-old',
      acornopsUserId: 'user-1',
      linkExpiresAt: new Date(Date.now() + 60000)
    });

    assert.equal(completed, false);
    assert.equal(queries.some((query) => query.sql.includes('INSERT INTO external_integration_user_links')), false);
    assert.equal(queries.some((query) => query.sql.includes('SET consumed_at = NOW()')), false);
  });

  it('exposes the external integration create API with the external user id', async () => {
    const originalConsoleBaseUrl = config.MANAGEMENT_CONSOLE_BASE_URL;
    try {
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = 'https://console.example.com';
      mock.method(repo, 'createExternalIntegrationLinkToken', async () => undefined);
      const res = createResponse();

      await createExternalIntegrationLinkRequest({
        body: {
          externalUserId: 'user-1'
        }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 200);
      const body = res.body as { linkUrl: string; expiresAt: string };
      assert.match(body.linkUrl, /^https:\/\/console\.example\.com\/integrations\/external-chat\/link\?token=intlink_/);
      assert.equal(typeof body.expiresAt, 'string');
    } finally {
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = originalConsoleBaseUrl;
    }
  });

  it('prevalidates external integration tokens before integration OIDC login returns to the console link route', async () => {
    const originalIssuer = config.OIDC_ISSUER_URL;
    const originalRedirectUri = config.OIDC_REDIRECT_URI;
    const originalTokenAuthMethod = config.OIDC_TOKEN_ENDPOINT_AUTH_METHOD;
    const originalConsoleBaseUrl = config.MANAGEMENT_CONSOLE_BASE_URL;
    let stateRecord: Record<string, unknown> | undefined;
    try {
      mutableConfig.OIDC_ISSUER_URL = 'https://issuer-external-integration-link.example.com';
      mutableConfig.OIDC_REDIRECT_URI = 'https://ops.example.com/api/v1/auth/oidc/callback';
      mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = 'none';
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = 'https://console.example.com';
      installOidcDiscovery(config.OIDC_ISSUER_URL);
      mock.method(repo, 'externalIntegrationLinkTokenIsPending', async () => true);
      mock.method(redis, 'setex', async (_key: string, _ttl: number, value: string) => {
        stateRecord = JSON.parse(value) as Record<string, unknown>;
        return 'OK';
      });

      const res = createResponse();
      await oidcLogin({
        query: {
          external_integration_link_token: 'intlink_token-1',
          return_to: 'https://console.example.com/integrations/external-chat/link?token=intlink_token-1'
        }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.match(res.redirectUrl, /^https:\/\/issuer-external-integration-link\.example\.com\/auth\?/);
      assert.equal(stateRecord?.purpose, 'integration_link');
      assert.equal(stateRecord?.returnTo, 'https://console.example.com/integrations/external-chat/link?token=intlink_token-1');
    } finally {
      mutableConfig.OIDC_ISSUER_URL = originalIssuer;
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
      mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = originalTokenAuthMethod;
      mutableConfig.MANAGEMENT_CONSOLE_BASE_URL = originalConsoleBaseUrl;
    }
  });

  it('completes links through the authenticated browser endpoint', async () => {
    mock.method(repo, 'getUserById', async () => ({
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      createdAt: '2026-06-08T00:00:00.000Z'
    }));
    let completed: Record<string, unknown> | undefined;
    mock.method(repo, 'completeExternalIntegrationLinkToken', async (input: Record<string, unknown>) => {
      completed = input;
      return true;
    });
    const res = createResponse();

    await completeExternalIntegrationLinkRequest({
      auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
      body: { token: 'intlink_token-1' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'linked' });
    assert.equal(completed?.tokenHash, hashExternalIntegrationLinkToken('intlink_token-1'));
    assert.equal(completed?.acornopsUserId, 'user-1');
  });

  it('returns expired when authenticated browser completion cannot consume the token', async () => {
    mock.method(repo, 'getUserById', async () => ({
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice',
      createdAt: '2026-06-08T00:00:00.000Z'
    }));
    mock.method(repo, 'completeExternalIntegrationLinkToken', async () => false);
    const res = createResponse();

    await completeExternalIntegrationLinkRequest({
      auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
      body: { token: 'intlink_token-1' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 410);
    assert.deepEqual(res.body, {
      error: {
        code: 'EXTERNAL_INTEGRATION_LINK_EXPIRED',
        message: 'External integration link token is expired or unavailable',
        retryable: false
      }
    });
  });

  it('resolves durable links for subsequent external integration requests', async () => {
    mock.method(repo, 'resolveExternalIntegrationUserLink', async () => ({
      status: 'linked',
      user: { id: 'user-1', email: 'alice@example.com', displayName: 'Alice' },
      link: {
        linkedAt: '2026-06-08T00:00:00.000Z',
        lastAuthenticatedAt: '2026-06-08T00:00:00.000Z',
        expiresAt: '2026-07-08T00:00:00.000Z'
      }
    }));
    const res = createResponse();

    await resolveExternalIntegrationLink({
      body: {
        externalUserId: 'user-1'
      }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { user: { id: string } }).user, {
      id: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice'
    });
  });

  it('requires the external integration service token', () => {
    const originalToken = config.EXTERNAL_INTEGRATION_SERVICE_TOKEN;
    try {
      mutableConfig.EXTERNAL_INTEGRATION_SERVICE_TOKEN = 'external-integration-token-1234567890';
      const deniedRes = createResponse();
      let nextCalled = false;
      requireExternalIntegrationServiceToken(
        { header: () => 'Bearer wrong-token' } as never,
        deniedRes as never,
        () => {
          nextCalled = true;
        }
      );
      assert.equal(deniedRes.statusCode, 401);
      assert.equal(nextCalled, false);

      const allowedRes = createResponse();
      requireExternalIntegrationServiceToken(
        { header: () => 'Bearer external-integration-token-1234567890' } as never,
        allowedRes as never,
        () => {
          nextCalled = true;
        }
      );
      assert.equal(nextCalled, true);
    } finally {
      mutableConfig.EXTERNAL_INTEGRATION_SERVICE_TOKEN = originalToken;
    }
  });
});
