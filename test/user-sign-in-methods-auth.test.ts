import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { passwordChange, passwordLogin } from '../src/controllers/auth-controller.js';
import { oidcCallback, oidcLogin, requireOidcConfigured } from '../src/controllers/oidc-auth-controller.js';
import { requestPasswordReset } from '../src/controllers/password-reset-controller.js';
import { config } from '../src/config.js';
import { applyPlatformSettingOverrides } from '../src/services/platform-settings.js';
import { repo } from '../src/store/repository.js';

function response() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    redirect(_url: string) { return this; },
    clearCookie(_name: string) { return this; }
  };
}

function disablePassword(): void {
  applyPlatformSettingOverrides([{
    key: 'user_sign_in_methods',
    overrideValue: { methods: ['oidc'] },
    version: 1,
    updatedAt: '2026-07-29T00:00:00.000Z'
  }]);
}

function disableOidc(): void {
  applyPlatformSettingOverrides([{
    key: 'user_sign_in_methods',
    overrideValue: { methods: ['password'] },
    version: 1,
    updatedAt: '2026-07-29T00:00:00.000Z'
  }]);
}

afterEach(() => {
  mock.restoreAll();
  applyPlatformSettingOverrides([]);
});

describe('user sign-in methods enforcement', () => {
  it('blocks every password entry point before credential access when Password is deselected', async () => {
    disablePassword();
    mock.method(repo, 'getPasswordCredentialByIdentifier', async () => {
      throw new Error('password lookup must not run');
    });
    mock.method(repo, 'getPasswordResetTokenContext', async () => {
      throw new Error('password reset lookup must not run');
    });
    mock.method(repo, 'getUserById', async () => {
      throw new Error('password change lookup must not run');
    });

    const loginResponse = response();
    await passwordLogin({ body: { identifier: 'user@example.com', password: 'password' } } as never, loginResponse as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(loginResponse.statusCode, 403);
    assert.equal((loginResponse.body as { error: { code: string } }).error.code, 'PASSWORD_AUTH_DISABLED');

    const resetResponse = response();
    await requestPasswordReset({ body: { email: 'user@example.com' } } as never, resetResponse as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(resetResponse.statusCode, 403);
    assert.equal((resetResponse.body as { error: { code: string } }).error.code, 'PASSWORD_RESET_DISABLED');

    const changeResponse = response();
    await passwordChange({ auth: { userId: 'user-1' }, body: { currentPassword: 'password', newPassword: 'new password' } } as never, changeResponse as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(changeResponse.statusCode, 403);
    assert.equal((changeResponse.body as { error: { code: string } }).error.code, 'PASSWORD_AUTH_DISABLED');
  });

  it('blocks ordinary OIDC login but keeps authenticated OIDC account-link setup available', async () => {
    disableOidc();
    const loginResponse = response();
    await oidcLogin({ query: {} } as never, loginResponse as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(loginResponse.statusCode, 403);
    assert.equal((loginResponse.body as { error: { code: string } }).error.code, 'OIDC_LOGIN_DISABLED');

    const originalOidcEnabled = config.OIDC_ENABLED;
    try {
      (config as typeof config & { OIDC_ENABLED: boolean }).OIDC_ENABLED = true;
      const linkResponse = response();
      let nextCalled = false;
      requireOidcConfigured({} as never, linkResponse as never, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(linkResponse.statusCode, 0);
    } finally {
      (config as typeof config & { OIDC_ENABLED: boolean }).OIDC_ENABLED = originalOidcEnabled;
    }
  });

  it('rechecks ordinary OIDC callback policy before account resolution', async () => {
    disableOidc();
    mock.method(repo, 'resolveOidcLogin', async () => {
      throw new Error('OIDC account resolution must not run');
    });
    const callbackResponse = response();
    await oidcCallback({
      query: { code: 'authorization-code', state: 'c4d75600-8459-4c9e-a2d9-6b00b2a59d15' },
      cookies: {}
    } as never, callbackResponse as never, (error?: unknown) => { if (error) throw error; }, async () => ({
      purpose: 'login' as const,
      userInfo: { sub: 'oidc-subject' },
      idToken: 'id-token',
      issuer: 'https://issuer.example.com',
      idTokenClaims: {},
      userInfoClaims: {}
    }));
    assert.equal(callbackResponse.statusCode, 403);
    assert.equal((callbackResponse.body as { error: { code: string } }).error.code, 'OIDC_LOGIN_DISABLED');
  });
});
