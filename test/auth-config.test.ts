import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { buildAuthorizationUrl, sanitizeOidcReturnTo } from '../src/auth/oidc.js';
import { config } from '../src/config.js';
import { authConfig, requireOidcConfigured } from '../src/controllers/auth-controller.js';
import { redis } from '../src/infra/redis.js';

const mutableConfig = config as typeof config & {
  OIDC_ENABLED: boolean;
  OIDC_HTTP_TIMEOUT_MS: number;
  OIDC_ISSUER_URL: string;
  OIDC_REDIRECT_URI: string;
  PASSWORD_AUTH_ENABLED: boolean;
  PASSWORD_SIGNUP_ENABLED: boolean;
  PASSWORD_EMAIL_VERIFICATION_REQUIRED: boolean;
  PASSWORD_RESET_ENABLED: boolean;
};
const testBrowserBindingHash = 'a'.repeat(64);

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

afterEach(() => mock.restoreAll());

describe('auth runtime config', () => {
  it('returns auth capability flags without secrets', async () => {
    const original = { ...config };
    try {
      mutableConfig.OIDC_ENABLED = false;
      mutableConfig.PASSWORD_AUTH_ENABLED = true;
      mutableConfig.PASSWORD_SIGNUP_ENABLED = false;
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = true;
      mutableConfig.PASSWORD_RESET_ENABLED = true;
      const res = createResponse();

      await authConfig({} as never, res as never, (err?: unknown) => { if (err) throw err; });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, {
        oidcEnabled: false,
        oidcProviderName: config.OIDC_PROVIDER_NAME,
        passwordAuthEnabled: true,
        passwordSignupEnabled: false,
        passwordEmailVerificationRequired: true,
        passwordResetEnabled: true
      });
      assert.equal(JSON.stringify(res.body).includes('secret'), false);
    } finally {
      mutableConfig.OIDC_ENABLED = original.OIDC_ENABLED;
      mutableConfig.PASSWORD_AUTH_ENABLED = original.PASSWORD_AUTH_ENABLED;
      mutableConfig.PASSWORD_SIGNUP_ENABLED = original.PASSWORD_SIGNUP_ENABLED;
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = original.PASSWORD_EMAIL_VERIFICATION_REQUIRED;
      mutableConfig.PASSWORD_RESET_ENABLED = original.PASSWORD_RESET_ENABLED;
    }
  });

  it('returns the bounded not-configured response before protected OIDC routes run', () => {
    const originalOidcEnabled = config.OIDC_ENABLED;
    try {
      mutableConfig.OIDC_ENABLED = false;
      const res = createResponse();
      let nextCalled = false;
      requireOidcConfigured({} as never, res as never, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 404);
      assert.equal((res.body as { error: { code: string } }).error.code, 'OIDC_NOT_CONFIGURED');
    } finally {
      mutableConfig.OIDC_ENABLED = originalOidcEnabled;
    }
  });

  it('times out stalled OIDC discovery requests', async () => {
    const originalTimeout = config.OIDC_HTTP_TIMEOUT_MS;
    const originalIssuer = config.OIDC_ISSUER_URL;
    const originalRedirectUri = config.OIDC_REDIRECT_URI;
    try {
      mutableConfig.OIDC_HTTP_TIMEOUT_MS = 5;
      mutableConfig.OIDC_ISSUER_URL = 'https://issuer-timeout.example.com';
      mutableConfig.OIDC_REDIRECT_URI = 'https://ops.example.com/api/v1/auth/oidc/callback';
      mock.method(redis, 'setex', async () => 'OK');
      mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }));
      await assert.rejects(
        buildAuthorizationUrl(config.OIDC_REDIRECT_URI, testBrowserBindingHash),
        /OIDC request timed out/
      );
    } finally {
      mutableConfig.OIDC_HTTP_TIMEOUT_MS = originalTimeout;
      mutableConfig.OIDC_ISSUER_URL = originalIssuer;
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('rejects OIDC login redirect_uri values outside the configured callback', async () => {
    const originalRedirectUri = config.OIDC_REDIRECT_URI;
    try {
      mutableConfig.OIDC_REDIRECT_URI = 'https://console.example.com/api/v1/auth/oidc/callback';
      await assert.rejects(
        buildAuthorizationUrl('https://attacker.example.com/api/v1/auth/oidc/callback', testBrowserBindingHash),
        /Invalid OIDC redirect_uri/
      );
    } finally {
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('does not persist unsafe OIDC return_to values', async () => {
    const originalIssuer = config.OIDC_ISSUER_URL;
    const originalRedirectUri = config.OIDC_REDIRECT_URI;
    let stateRecord: Record<string, unknown> | undefined;
    try {
      mutableConfig.OIDC_ISSUER_URL = 'https://issuer-return-to.example.com';
      mutableConfig.OIDC_REDIRECT_URI = 'https://console.example.com/api/v1/auth/oidc/callback';
      mock.method(redis, 'setex', async (_key: string, _ttl: number, value: string) => {
        stateRecord = JSON.parse(value) as Record<string, unknown>;
        return 'OK';
      });
      mock.method(globalThis, 'fetch', async () => Response.json({
        issuer: config.OIDC_ISSUER_URL,
        authorization_endpoint: 'https://issuer-return-to.example.com/auth',
        token_endpoint: 'https://issuer-return-to.example.com/token'
      }));
      await buildAuthorizationUrl(config.OIDC_REDIRECT_URI, testBrowserBindingHash, '//attacker.example.com/path');
      assert.equal(stateRecord?.returnTo, undefined);
    } finally {
      mutableConfig.OIDC_ISSUER_URL = originalIssuer;
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('rejects backslash and protocol-relative return_to variants', () => {
    assert.equal(sanitizeOidcReturnTo('//attacker.example.com/path'), undefined);
    assert.equal(sanitizeOidcReturnTo('/\\attacker.example.com/path'), undefined);
    assert.equal(sanitizeOidcReturnTo('/workspaces?tab=active#ready'), '/workspaces?tab=active#ready');
  });
});
