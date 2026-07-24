import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminAssuranceFromClaims, adminRolesFromClaims } from '../src/auth/admin-oidc.js';
import { config } from '../src/config.js';

describe('platform admin OIDC policy', () => {
  it('accepts only the three configured platform roles from Keycloak claims', () => {
    assert.deepEqual(adminRolesFromClaims({ realm_access: { roles: ['platform-admin-viewer', 'workspace-owner'] } }), ['platform-admin-viewer']);
    assert.deepEqual(adminRolesFromClaims({ resource_access: { [config.ADMIN_OIDC_CLIENT_ID]: { roles: ['platform-admin-auditor'] } } }), ['platform-admin-auditor']);
    assert.deepEqual(adminRolesFromClaims({ realm_access: { roles: ['workspace-owner', 'admin'] } }), []);
  });

  it('requires an accepted MFA assurance claim', () => {
    assert.deepEqual(adminAssuranceFromClaims({ amr: ['pwd', 'mfa'] }), { amr: ['pwd', 'mfa'] });
    assert.throws(() => adminAssuranceFromClaims({ amr: ['pwd'] }), /ADMIN_MFA_REQUIRED/);
  });
});
