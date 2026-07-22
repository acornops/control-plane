import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  consumeOidcLogoutState,
  createOidcLogoutRequest,
  startOidcLogout
} from '../src/auth/oidc-logout.js';
import type { BrowserSession } from '../src/auth/session.js';
import { config } from '../src/config.js';
import { logout, oidcLogoutCallback } from '../src/controllers/oidc-logout-controller.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';

const mutableConfig = config as typeof config & {
  OIDC_END_SESSION_ENDPOINT_OVERRIDE?: string;
};

const session: BrowserSession = {
  version: 2,
  id: 'session-1',
  userId: 'user-1',
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  authMethod: 'oidc',
  oidc: {
    provider: config.OIDC_PROVIDER_NAME,
    issuer: config.OIDC_ISSUER_URL,
    idToken: 'secret-id-token'
  }
};

afterEach(() => mock.restoreAll());

describe('OIDC RP-initiated logout', () => {
  it('revokes the local session before returning an opaque AcornOps handoff', async () => {
    const writes: string[] = [];
    mock.method(redis, 'getdel', async () => JSON.stringify(session));
    mock.method(redis, 'srem', async () => 1);
    mock.method(redis, 'del', async () => 1);
    mock.method(redis, 'setex', async (_key: string, _ttl: number, value: string) => {
      writes.push(value);
      return 'OK';
    });
    mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      cookieCleared: false,
      set: () => response,
      clearCookie: () => {
        response.cookieCleared = true;
        return response;
      },
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      json(body: unknown) {
        response.body = body;
        return response;
      }
    };
    await logout({ cookies: { [config.SESSION_COOKIE_NAME]: session.id } } as never, response as never, (err?: unknown) => {
      if (err) throw err;
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.cookieCleared, true);
    assert.equal(JSON.stringify(response.body).includes('secret-id-token'), false);
    assert.match((response.body as { redirectPath: string }).redirectPath, /^\/api\/v1\/auth\/oidc\/logout\/start\?request=/);
    assert.equal(writes.some((value) => value.includes('secret-id-token')), true);
  });

  it('keeps local logout successful when the provider handoff cannot be stored', async () => {
    mock.method(redis, 'getdel', async () => JSON.stringify(session));
    mock.method(redis, 'srem', async () => 1);
    mock.method(redis, 'del', async () => 1);
    mock.method(redis, 'setex', async () => { throw new Error('redis write failed'); });
    mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      set: () => response,
      clearCookie: () => response,
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      json(body: unknown) {
        response.body = body;
        return response;
      }
    };

    await logout({ cookies: { [config.SESSION_COOKIE_NAME]: session.id } } as never, response as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      status: 'ok', mode: 'local', redirectPath: '/?logout_result=local_only'
    });
  });

  it('clears the browser cookie even if Redis cannot revoke the server session', async () => {
    mock.method(redis, 'getdel', async () => { throw new Error('redis unavailable'); });
    let nextError: unknown;
    let cookieCleared = false;
    const response = {
      set: () => response,
      clearCookie: () => {
        cookieCleared = true;
        return response;
      }
    };

    await logout(
      { cookies: { [config.SESSION_COOKIE_NAME]: session.id } } as never,
      response as never,
      (err?: unknown) => { nextError = err; }
    );

    assert.match(String(nextError), /redis unavailable/);
    assert.equal(cookieCleared, true);
  });

  it('keeps the ID token server-side and emits a single-use provider redirect', async () => {
    const originalOverride = config.OIDC_END_SESSION_ENDPOINT_OVERRIDE;
    const writes: Array<{ key: string; ttl: number; value: string }> = [];
    try {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = 'https://identity.example.com/logout';
      mock.method(redis, 'setex', async (key: string, ttl: number, value: string) => {
        writes.push({ key, ttl, value });
        return 'OK';
      });
      const handle = await createOidcLogoutRequest(session);
      assert.ok(handle);
      assert.equal(handle.includes('secret-id-token'), false);
      const requestWrite = writes[0];
      let requestValue: string | null = requestWrite.value;
      mock.method(redis, 'getdel', async (key: string) => {
        if (key !== requestWrite.key) return null;
        const value = requestValue;
        requestValue = null;
        return value;
      });

      const started = await startOidcLogout(handle);
      assert.ok(started);
      const providerUrl = new URL(started.providerUrl);
      assert.equal(providerUrl.origin, 'https://identity.example.com');
      assert.equal(providerUrl.searchParams.get('id_token_hint'), 'secret-id-token');
      assert.equal(providerUrl.searchParams.get('client_id'), config.OIDC_CLIENT_ID);
      assert.equal(providerUrl.searchParams.get('post_logout_redirect_uri'), config.OIDC_POST_LOGOUT_REDIRECT_URI);
      assert.ok(providerUrl.searchParams.get('state'));
      assert.equal(writes[1].ttl, 600);
      assert.equal(await startOidcLogout(handle), null);

      mock.restoreAll();
      let stateValue: string | null = writes[1].value;
      mock.method(redis, 'getdel', async () => {
        const value = stateValue;
        stateValue = null;
        return value;
      });
      const consumed = await consumeOidcLogoutState(providerUrl.searchParams.get('state') || '');
      assert.equal(consumed?.userId, 'user-1');
      assert.equal(await consumeOidcLogoutState(providerUrl.searchParams.get('state') || ''), null);
    } finally {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = originalOverride;
    }
  });

  it('returns no provider redirect for invalid or expired handoff handles', async () => {
    mock.method(redis, 'getdel', async () => null);
    assert.equal(await startOidcLogout('invalid'), null);
    assert.equal(await startOidcLogout('a'.repeat(43)), null);
  });

  it('treats logout-state storage failures as an incomplete provider logout', async () => {
    mock.method(redis, 'getdel', async () => { throw new Error('redis unavailable'); });
    mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
    const response = {
      redirectUrl: '',
      set: () => response,
      redirect(_status: number, url: string) {
        response.redirectUrl = url;
        return response;
      }
    };

    await oidcLogoutCallback({ query: { state: 'a'.repeat(43) } } as never, response as never);

    assert.equal(new URL(response.redirectUrl).searchParams.get('logout_result'), 'incomplete');
  });

  it('audits invalid or expired provider logout callbacks without exposing state', async () => {
    const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
    mock.method(redis, 'getdel', async () => null);
    mock.method(repo, 'insertAccountAuditEvent', async (event: { eventType: string; metadata?: Record<string, unknown> }) => {
      auditEvents.push(event);
    });
    const response = {
      redirectUrl: '',
      set: () => response,
      redirect(_status: number, url: string) {
        response.redirectUrl = url;
        return response;
      }
    };

    await oidcLogoutCallback({ query: { state: 'sensitive-state-value'.padEnd(43, 'x') } } as never, response as never);

    assert.equal(new URL(response.redirectUrl).searchParams.get('logout_result'), 'incomplete');
    assert.equal(auditEvents[0].eventType, 'auth.logout.oidc_fallback.v1');
    assert.equal(JSON.stringify(auditEvents).includes('sensitive-state-value'), false);
  });

  it('rejects handoffs created for a different provider', async () => {
    const originalOverride = config.OIDC_END_SESSION_ENDPOINT_OVERRIDE;
    try {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = 'https://identity.example.com/logout';
      const writes: Array<{ key: string; value: string }> = [];
      mock.method(redis, 'setex', async (key: string, _ttl: number, value: string) => {
        writes.push({ key, value });
        return 'OK';
      });
      const handle = await createOidcLogoutRequest({
        ...session,
        oidc: { ...session.oidc!, provider: 'different-provider' }
      });
      assert.ok(handle);
      mock.method(redis, 'getdel', async () => writes[0].value);

      assert.equal(await startOidcLogout(handle), null);
      assert.equal(writes.length, 1);
    } finally {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = originalOverride;
    }
  });

  it('rejects non-HTTP provider logout endpoints', async () => {
    const originalOverride = config.OIDC_END_SESSION_ENDPOINT_OVERRIDE;
    try {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = 'javascript:alert(1)';
      const writes: Array<{ key: string; value: string }> = [];
      mock.method(redis, 'setex', async (key: string, _ttl: number, value: string) => {
        writes.push({ key, value });
        return 'OK';
      });
      const handle = await createOidcLogoutRequest(session);
      assert.ok(handle);
      mock.method(redis, 'getdel', async () => writes[0].value);

      assert.equal(await startOidcLogout(handle), null);
      assert.equal(writes.length, 1);
    } finally {
      mutableConfig.OIDC_END_SESSION_ENDPOINT_OVERRIDE = originalOverride;
    }
  });
});
