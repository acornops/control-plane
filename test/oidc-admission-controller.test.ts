import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { OidcAdmissionPolicy } from '../src/config-oidc-admission.js';
import { config } from '../src/config.js';
import { oidcCallback } from '../src/controllers/auth-controller.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';

const mutableConfig = config as typeof config & {
  OIDC_ADMISSION_POLICY: OidcAdmissionPolicy;
};

function createResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    redirectUrl: '',
    clearedCookies: [] as string[],
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(statusOrUrl: number | string, maybeUrl?: string) {
      this.statusCode = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      this.redirectUrl = typeof statusOrUrl === 'string' ? statusOrUrl : (maybeUrl || '');
      return this;
    },
    clearCookie(name: string) {
      this.clearedCookies.push(name);
      return this;
    }
  };
}

afterEach(() => mock.restoreAll());

describe('OIDC admission callback ordering', () => {
  it('clears the browser transaction cookie even for malformed provider callbacks', async () => {
    const res = createResponse();
    let callbackError: unknown;

    await oidcCallback({ query: {}, cookies: {} } as never, res as never, (err?: unknown) => {
      callbackError = err;
    });

    assert.equal(callbackError, undefined);
    assert.equal(res.statusCode, 400);
    assert.equal(res.clearedCookies.length, 1);
  });

  it('denies login, link, and integration-link callbacks before account, identity, or session mutation', async () => {
    const originalPolicy = config.OIDC_ADMISSION_POLICY;
    try {
      mutableConfig.OIDC_ADMISSION_POLICY = {
        requiredClaims: [{ path: ['groups'], operator: 'contains', value: 'acornops-users' }]
      };

      let purpose: 'login' | 'link' | 'integration_link' = 'login';
      mock.method(redis, 'eval', async () => {
        throw new Error('Admission denial must not create a browser session');
      });
      mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
      mock.method(repo, 'resolveOidcLogin', async () => {
        throw new Error('Admission denial must not resolve or create an account');
      });
      mock.method(repo, 'linkFederatedIdentity', async () => {
        throw new Error('Admission denial must not create an identity link');
      });

      for (purpose of ['login', 'link', 'integration_link']) {
        const res = createResponse();
        let callbackError: unknown;
        await oidcCallback({ query: { state: 'state-1', code: 'code-1' }, cookies: {} } as never, res as never, (err?: unknown) => {
          callbackError = err;
        }, async () => ({
          userInfo: {
            sub: 'subject-1',
            email: 'alice@example.com',
            email_verified: true
          },
          purpose,
          linkUserId: purpose === 'link' ? 'user-1' : undefined,
          linkSessionId: purpose === 'link' ? 'session-1' : undefined,
          idToken: 'secret-id-token',
          issuer: config.OIDC_ISSUER_URL,
          idTokenClaims: {
            sub: 'subject-1',
            email: 'alice@example.com',
            email_verified: true
          },
          userInfoClaims: {}
        }));
        assert.equal(callbackError, undefined);
        assert.equal(res.statusCode, 303);
        assert.equal(new URL(res.redirectUrl).searchParams.get('auth_result'), 'oidc_access_denied');
      }
    } finally {
      mutableConfig.OIDC_ADMISSION_POLICY = originalPolicy;
    }
  });

  it('does not recreate a linked session after concurrent logout', async () => {
    const originalPolicy = config.OIDC_ADMISSION_POLICY;
    try {
      mutableConfig.OIDC_ADMISSION_POLICY = {};
      const now = Date.now();
      mock.method(redis, 'get', async () => JSON.stringify({
        version: 2,
        id: 'session-1',
        userId: 'user-1',
        createdAt: new Date(now - 60_000).toISOString(),
        lastSeenAt: new Date(now - 60_000).toISOString(),
        absoluteExpiresAt: new Date(now + 60_000).toISOString(),
        idleExpiresAt: new Date(now + 60_000).toISOString(),
        authMethod: 'password'
      }));
      let evalCount = 0;
      mock.method(redis, 'eval', async () => ++evalCount === 1 ? 1 : 0);
      mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
      mock.method(repo, 'getAuthMethodsForUser', async () => ({
        methods: [],
        capabilities: { canChangePassword: true, canLinkOidc: true, canAddPassword: false }
      }));
      mock.method(repo, 'linkFederatedIdentity', async () => ({ status: 'linked' }));
      const res = createResponse();
      let callbackError: unknown;

      await oidcCallback({
        query: { state: 'state-1', code: 'code-1' },
        cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
      } as never, res as never, (err?: unknown) => { callbackError = err; }, async () => ({
        userInfo: { sub: 'subject-1', email: 'alice@example.com', email_verified: true },
        purpose: 'link',
        linkUserId: 'user-1',
        linkSessionId: 'session-1',
        idToken: 'secret-id-token',
        issuer: config.OIDC_ISSUER_URL,
        idTokenClaims: { sub: 'subject-1', email: 'alice@example.com', email_verified: true },
        userInfoClaims: {}
      }));

      assert.equal(callbackError, undefined);
      assert.equal(res.statusCode, 401);
      assert.equal((res.body as { error: { code: string } }).error.code, 'OIDC_LINK_SESSION_EXPIRED');
      assert.equal(evalCount, 2);
      assert.equal(res.clearedCookies.length >= 2, true);
    } finally {
      mutableConfig.OIDC_ADMISSION_POLICY = originalPolicy;
    }
  });
});
