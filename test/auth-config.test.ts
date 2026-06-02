import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { authConfig } from '../src/controllers/auth-controller.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { buildAuthorizationUrl, exchangeCodeForUser, mergeUserClaims, validateOidcNonce } from '../src/auth/oidc.js';
import { logger } from '../src/logger.js';

const mutableConfig = config as typeof config & {
  CORS_ORIGIN: string;
  OIDC_HTTP_TIMEOUT_MS: number;
  OIDC_ISSUER_URL: string;
  OIDC_REDIRECT_URI: string;
  OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic' | 'client_secret_post' | 'none';
  OIDC_USE_USERINFO: boolean;
  PASSWORD_AUTH_ENABLED: boolean;
  PASSWORD_SIGNUP_ENABLED: boolean;
  PASSWORD_EMAIL_VERIFICATION_REQUIRED: boolean;
  PASSWORD_RESET_ENABLED: boolean;
};

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

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function mockOidcExchangeWithoutIdToken(issuer: string): void {
  mock.method(redis, 'get', async () => JSON.stringify({
    provider: config.OIDC_PROVIDER_NAME,
    purpose: 'login',
    state: 'state-1',
    nonce: 'expected-nonce',
    codeVerifier: 'verifier-1',
    redirectUri: config.OIDC_REDIRECT_URI,
    createdAt: Date.now()
  }));
  mock.method(redis, 'del', async () => 1);
  mock.method(globalThis, 'fetch', async (rawInput: string | URL | Request) => {
    const url = requestUrl(rawInput);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200
      });
    }
    if (url === `${issuer}/token`) {
      return new Response(JSON.stringify({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 300
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200
      });
    }
    return new Response('not found', { status: 404 });
  });
}

async function withOidcExchangeConfig<T>(issuer: string, run: () => Promise<T>): Promise<T> {
  const originalIssuer = config.OIDC_ISSUER_URL;
  const originalRedirectUri = config.OIDC_REDIRECT_URI;
  const originalTokenAuthMethod = config.OIDC_TOKEN_ENDPOINT_AUTH_METHOD;
  const originalUseUserInfo = config.OIDC_USE_USERINFO;
  try {
    mutableConfig.OIDC_ISSUER_URL = issuer;
    mutableConfig.OIDC_REDIRECT_URI = 'https://ops.example.com/api/v1/auth/oidc/callback';
    mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = 'none';
    mutableConfig.OIDC_USE_USERINFO = true;
    return await run();
  } finally {
    mutableConfig.OIDC_ISSUER_URL = originalIssuer;
    mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = originalTokenAuthMethod;
    mutableConfig.OIDC_USE_USERINFO = originalUseUserInfo;
  }
}

afterEach(() => {
  mock.restoreAll();
});

describe('auth runtime config', () => {
  it('returns auth capability flags without secrets', async () => {
    const originalPasswordAuth = config.PASSWORD_AUTH_ENABLED;
    const originalPasswordSignup = config.PASSWORD_SIGNUP_ENABLED;
    const originalPasswordVerificationRequired = config.PASSWORD_EMAIL_VERIFICATION_REQUIRED;
    const originalPasswordReset = config.PASSWORD_RESET_ENABLED;
    try {
      mutableConfig.PASSWORD_AUTH_ENABLED = true;
      mutableConfig.PASSWORD_SIGNUP_ENABLED = false;
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = true;
      mutableConfig.PASSWORD_RESET_ENABLED = true;
      const res = createResponse();

      await authConfig({} as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, {
        oidcEnabled: true,
        oidcProviderName: config.OIDC_PROVIDER_NAME,
        passwordAuthEnabled: true,
        passwordSignupEnabled: false,
        passwordEmailVerificationRequired: true,
        passwordResetEnabled: true
      });
      assert.equal(JSON.stringify(res.body).includes('secret'), false);
    } finally {
      mutableConfig.PASSWORD_AUTH_ENABLED = originalPasswordAuth;
      mutableConfig.PASSWORD_SIGNUP_ENABLED = originalPasswordSignup;
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = originalPasswordVerificationRequired;
      mutableConfig.PASSWORD_RESET_ENABLED = originalPasswordReset;
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
        buildAuthorizationUrl('https://ops.example.com/api/v1/auth/oidc/callback'),
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
        buildAuthorizationUrl('https://attacker.example.com/api/v1/auth/oidc/callback'),
        /Invalid OIDC redirect_uri/
      );
    } finally {
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('rejects protocol-relative OIDC return_to values', async () => {
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
      mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        issuer: config.OIDC_ISSUER_URL,
        authorization_endpoint: 'https://issuer-return-to.example.com/auth',
        token_endpoint: 'https://issuer-return-to.example.com/token',
        userinfo_endpoint: 'https://issuer-return-to.example.com/userinfo'
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200
      }));

      await buildAuthorizationUrl(config.OIDC_REDIRECT_URI, '//attacker.example.com/post-login');

      assert.equal(stateRecord?.returnTo, undefined);
    } finally {
      mutableConfig.OIDC_ISSUER_URL = originalIssuer;
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('does not let missing userinfo claims erase id_token verification claims', () => {
    assert.deepEqual(
      mergeUserClaims(
        {
          sub: 'subject-1',
          email: 'alice@example.com',
          email_verified: false,
          name: 'Alice'
        },
        {
          sub: 'subject-1'
        }
      ),
      {
        sub: 'subject-1',
        email: 'alice@example.com',
        email_verified: false,
        preferred_username: undefined,
        name: 'Alice'
      }
    );
  });

  it('requires OIDC id_token nonce to exist and match state', () => {
    assert.doesNotThrow(() => validateOidcNonce({ nonce: 'expected-nonce' }, 'expected-nonce'));
    assert.throws(() => validateOidcNonce({}, 'expected-nonce'), /OIDC nonce missing/);
    assert.throws(
      () => validateOidcNonce({ nonce: 'attacker-nonce' }, 'expected-nonce'),
      /OIDC nonce mismatch/
    );
  });

  it('rejects OIDC token responses missing id_token', async () => {
    const issuer = 'https://issuer-missing-id-token.example.com';
    await withOidcExchangeConfig(issuer, async () => {
      mockOidcExchangeWithoutIdToken(issuer);

      await assert.rejects(
        exchangeCodeForUser('state-1', 'code-1'),
        /OIDC token response missing id_token/
      );
    });
  });

  it('logs OIDC token failure metadata without provider response bodies', async () => {
    const issuer = 'https://issuer-token-failure.example.com';
    const errorBody = JSON.stringify({
      error: 'invalid_grant',
      access_token: 'secret-access-token',
      id_token: 'secret-id-token',
      refresh_token: 'secret-refresh-token',
      email: 'alice@example.com',
      sub: 'subject-1'
    });
    const logCalls: Array<unknown[]> = [];

    await withOidcExchangeConfig(issuer, async () => {
      mock.method(redis, 'get', async () => JSON.stringify({
        provider: config.OIDC_PROVIDER_NAME,
        purpose: 'login',
        state: 'state-1',
        nonce: 'expected-nonce',
        codeVerifier: 'verifier-1',
        redirectUri: config.OIDC_REDIRECT_URI,
        createdAt: Date.now()
      }));
      mock.method(globalThis, 'fetch', async (rawInput: string | URL | Request) => {
        const url = requestUrl(rawInput);
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return new Response(JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`
          }), {
            headers: { 'content-type': 'application/json' },
            status: 200
          });
        }
        if (url === `${issuer}/token`) {
          return new Response(errorBody, { status: 400 });
        }
        return new Response('not found', { status: 404 });
      });
      mock.method(logger, 'error', (...args: unknown[]) => {
        logCalls.push(args);
      });

      await assert.rejects(
        exchangeCodeForUser('state-1', 'code-1'),
        /OIDC token exchange failed \(400\)/
      );
    });

    const serializedLogs = JSON.stringify(logCalls);
    assert.match(serializedLogs, /"status":400/);
    assert.doesNotMatch(serializedLogs, /secret-access-token|secret-id-token|secret-refresh-token|alice@example\.com|subject-1/);
    assert.doesNotMatch(serializedLogs, /"body"/);
  });

  it('rejects missing or mismatched UserInfo subjects', () => {
    assert.throws(
      () => mergeUserClaims({ sub: 'subject-1' }, { email: 'alice@example.com' }, { requireUserInfoSubject: true }),
      /OIDC userinfo missing subject/
    );
    assert.throws(
      () => mergeUserClaims({ sub: 'subject-1' }, { sub: 'subject-2' }, { requireUserInfoSubject: true }),
      /OIDC subject mismatch/
    );
  });

  it('accepts matching id_token and UserInfo subjects', () => {
    const result = mergeUserClaims(
      { sub: 'subject-1', email: 'alice@example.com' },
      { sub: 'subject-1', email: 'alice.userinfo@example.com', email_verified: true },
      { requireUserInfoSubject: true }
    );

    assert.equal(result.sub, 'subject-1');
    assert.equal(result.email, 'alice.userinfo@example.com');
    assert.equal(result.email_verified, true);
  });
});
