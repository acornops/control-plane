import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminOidcFailure } from '../src/auth/admin-oidc-errors.js';

describe('platform admin OIDC public failures', () => {
  it('maps identity-provider outages to a stable retryable response', () => {
    assert.deepEqual(adminOidcFailure(new Error('ADMIN_OIDC_DISCOVERY_UNAVAILABLE')), {
      reason: 'ADMIN_OIDC_DISCOVERY_UNAVAILABLE',
      status: 503,
      error: {
        code: 'ADMIN_IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'Platform administrator sign-in is temporarily unavailable',
        retryable: true
      }
    });
  });

  it('does not expose discovery configuration details', () => {
    const result = adminOidcFailure(new Error('ADMIN_OIDC_ISSUER_MISMATCH'));
    assert.equal(result.status, 503);
    assert.equal(result.error.code, 'ADMIN_IDENTITY_PROVIDER_MISCONFIGURED');
    assert.equal(result.error.retryable, false);
    assert.doesNotMatch(result.error.message, /issuer/i);
  });

  it('preserves role and MFA denials without making them retryable', () => {
    assert.equal(adminOidcFailure(new Error('ADMIN_ROLE_REQUIRED')).status, 403);
    assert.equal(adminOidcFailure(new Error('ADMIN_MFA_REQUIRED')).error.code, 'ADMIN_MFA_REQUIRED');
  });

  it('normalizes invalid identity tokens without exposing verifier details', () => {
    const result = adminOidcFailure(new Error('ADMIN_OIDC_ID_TOKEN_INVALID'));
    assert.equal(result.status, 401);
    assert.equal(result.error.code, 'ADMIN_SIGN_IN_REJECTED');
    assert.equal(result.error.retryable, false);
  });

  it('fails unknown internal errors closed behind a safe public response', () => {
    const result = adminOidcFailure(new TypeError('socket contained secret details'));
    assert.equal(result.reason, 'ADMIN_OIDC_INTERNAL_FAILURE');
    assert.equal(result.status, 503);
    assert.equal(result.error.code, 'ADMIN_SIGN_IN_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.error), /socket|secret/i);
  });
});
