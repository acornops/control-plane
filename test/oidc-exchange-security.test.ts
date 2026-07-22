import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  buildAuthorizationUrl,
  exchangeCodeForUser,
  mergeUserClaims,
  validateOidcAuthorizedParty,
  validateOidcNonce
} from '../src/auth/oidc.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { logger } from '../src/logger.js';

const mutableConfig = config as typeof config & {
  OIDC_ISSUER_URL: string;
  OIDC_REDIRECT_URI: string;
  OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic' | 'client_secret_post' | 'none';
  OIDC_USE_USERINFO: boolean;
};
const testState = '123e4567-e89b-42d3-a456-426614174000';
const testBrowserBindingHash = 'a'.repeat(64);

function stateRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    provider: config.OIDC_PROVIDER_NAME,
    purpose: 'login',
    state: testState,
    nonce: 'expected-nonce-value',
    codeVerifier: 'v'.repeat(43),
    browserBindingHash: testBrowserBindingHash,
    redirectUri: config.OIDC_REDIRECT_URI,
    createdAt: Date.now(),
    ...overrides
  };
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

async function withExchangeConfig<T>(issuer: string, run: () => Promise<T>): Promise<T> {
  const original = { ...config };
  try {
    mutableConfig.OIDC_ISSUER_URL = issuer;
    mutableConfig.OIDC_REDIRECT_URI = 'https://ops.example.com/api/v1/auth/oidc/callback';
    mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = 'none';
    mutableConfig.OIDC_USE_USERINFO = true;
    return await run();
  } finally {
    mutableConfig.OIDC_ISSUER_URL = original.OIDC_ISSUER_URL;
    mutableConfig.OIDC_REDIRECT_URI = original.OIDC_REDIRECT_URI;
    mutableConfig.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = original.OIDC_TOKEN_ENDPOINT_AUTH_METHOD;
    mutableConfig.OIDC_USE_USERINFO = original.OIDC_USE_USERINFO;
  }
}

function installDiscoveryAndTokenResponse(issuer: string, tokenResponse: Response): void {
  mock.method(globalThis, 'fetch', async (rawInput: string | URL | Request) => {
    const url = requestUrl(rawInput);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`
      });
    }
    if (url === `${issuer}/token`) return tokenResponse;
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => mock.restoreAll());

describe('OIDC exchange security', () => {
  it('rejects structurally invalid or stale state records before token exchange', async () => {
    const records = [
      stateRecord({ version: 1 }),
      stateRecord({ provider: 'unexpected-provider' }),
      stateRecord({ redirectUri: 'https://attacker.example.com/callback' }),
      stateRecord({ purpose: 'unknown' }),
      stateRecord({ createdAt: Date.now() - 11 * 60 * 1000 })
    ];
    let current = records[0];
    let tokenExchangeStarted = false;
    mock.method(redis, 'getdel', async () => JSON.stringify(current));
    mock.method(globalThis, 'fetch', async () => {
      tokenExchangeStarted = true;
      return new Response('unexpected', { status: 500 });
    });
    for (current of records) {
      await assert.rejects(exchangeCodeForUser(testState, 'code-1', testBrowserBindingHash), /Invalid OIDC state/);
    }
    assert.equal(tokenExchangeStarted, false);
  });

  it('rejects authorization responses not bound to the initiating browser', async () => {
    let tokenExchangeStarted = false;
    mock.method(redis, 'getdel', async () => JSON.stringify(stateRecord()));
    mock.method(globalThis, 'fetch', async () => {
      tokenExchangeStarted = true;
      return new Response('unexpected', { status: 500 });
    });
    await assert.rejects(exchangeCodeForUser(testState, 'code-1', undefined), /Invalid OIDC state/);
    await assert.rejects(exchangeCodeForUser(testState, 'code-1', 'b'.repeat(64)), /Invalid OIDC state/);
    assert.equal(tokenExchangeStarted, false);
  });

  it('rejects discovery metadata issued under an unexpected issuer', async () => {
    const originalIssuer = config.OIDC_ISSUER_URL;
    const originalRedirectUri = config.OIDC_REDIRECT_URI;
    try {
      mutableConfig.OIDC_ISSUER_URL = 'https://configured-issuer.example.com';
      mutableConfig.OIDC_REDIRECT_URI = 'https://console.example.com/api/v1/auth/oidc/callback';
      mock.method(globalThis, 'fetch', async () => Response.json({
        issuer: 'https://different-issuer.example.com',
        authorization_endpoint: 'https://different-issuer.example.com/auth',
        token_endpoint: 'https://different-issuer.example.com/token'
      }));
      await assert.rejects(
        buildAuthorizationUrl(config.OIDC_REDIRECT_URI, testBrowserBindingHash),
        /discovery issuer mismatch/
      );
    } finally {
      mutableConfig.OIDC_ISSUER_URL = originalIssuer;
      mutableConfig.OIDC_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('preserves ID-token profile values when UserInfo omits them', () => {
    assert.deepEqual(
      mergeUserClaims(
        { sub: 'subject-1', email: 'alice@example.com', email_verified: false, name: 'Alice' },
        { sub: 'subject-1' }
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

  it('requires the ID-token nonce and authorized party', () => {
    assert.doesNotThrow(() => validateOidcNonce({ nonce: 'expected-nonce' }, 'expected-nonce'));
    assert.throws(() => validateOidcNonce({}, 'expected-nonce'), /OIDC nonce missing/);
    assert.throws(() => validateOidcNonce({ nonce: 'other' }, 'expected-nonce'), /OIDC nonce mismatch/);
    assert.doesNotThrow(() => validateOidcAuthorizedParty({ aud: config.OIDC_CLIENT_ID }));
    assert.doesNotThrow(() => validateOidcAuthorizedParty({
      aud: [config.OIDC_CLIENT_ID, 'resource-server'], azp: config.OIDC_CLIENT_ID
    }));
    assert.throws(
      () => validateOidcAuthorizedParty({ aud: [config.OIDC_CLIENT_ID, 'resource-server'] }),
      /authorized party missing/
    );
    assert.throws(
      () => validateOidcAuthorizedParty({ aud: config.OIDC_CLIENT_ID, azp: 'different-client' }),
      /authorized party mismatch/
    );
  });

  it('rejects token responses missing an ID token', async () => {
    const issuer = 'https://issuer-missing-id-token.example.com';
    await withExchangeConfig(issuer, async () => {
      mock.method(redis, 'getdel', async () => JSON.stringify(stateRecord()));
      installDiscoveryAndTokenResponse(issuer, Response.json({
        access_token: 'access-token', token_type: 'Bearer', expires_in: 300
      }));
      await assert.rejects(
        exchangeCodeForUser(testState, 'code-1', testBrowserBindingHash),
        /OIDC token response missing id_token/
      );
    });
  });

  it('logs token failure metadata without provider response bodies', async () => {
    const issuer = 'https://issuer-token-failure.example.com';
    const logCalls: Array<unknown[]> = [];
    await withExchangeConfig(issuer, async () => {
      mock.method(redis, 'getdel', async () => JSON.stringify(stateRecord()));
      installDiscoveryAndTokenResponse(issuer, new Response(JSON.stringify({
        error: 'invalid_grant',
        access_token: 'secret-access-token',
        id_token: 'secret-id-token',
        refresh_token: 'secret-refresh-token',
        email: 'alice@example.com',
        sub: 'subject-1'
      }), { status: 400 }));
      mock.method(logger, 'error', (...args: unknown[]) => { logCalls.push(args); });
      await assert.rejects(
        exchangeCodeForUser(testState, 'code-1', testBrowserBindingHash),
        /OIDC token exchange failed \(400\)/
      );
    });
    const serialized = JSON.stringify(logCalls);
    assert.match(serialized, /"status":400/);
    assert.doesNotMatch(serialized, /secret-access-token|secret-id-token|secret-refresh-token|alice@example\.com|subject-1/);
    assert.doesNotMatch(serialized, /"body"/);
  });

  it('rejects missing or mismatched UserInfo subjects and accepts a match', () => {
    assert.throws(
      () => mergeUserClaims({ sub: 'subject-1' }, { email: 'alice@example.com' }, { requireUserInfoSubject: true }),
      /OIDC userinfo missing subject/
    );
    assert.throws(
      () => mergeUserClaims({ sub: 'subject-1' }, { sub: 'subject-2' }, { requireUserInfoSubject: true }),
      /OIDC subject mismatch/
    );
    const result = mergeUserClaims(
      { sub: 'subject-1', email: 'alice@example.com' },
      { sub: 'subject-1', email: 'alice.userinfo@example.com', email_verified: true },
      { requireUserInfoSubject: true }
    );
    assert.equal(result.email, 'alice.userinfo@example.com');
    assert.equal(result.email_verified, true);
  });
});
