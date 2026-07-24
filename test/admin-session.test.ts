import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminScopesForRoles, adminSessionReference, clearAdminSessionCookie } from '../src/auth/admin-session.js';
import { config } from '../src/config.js';

describe('platform administrator role mapping', () => {
  it('keeps the three production roles simple and least privileged', () => {
    assert.deepEqual(adminScopesForRoles(['platform-admin-viewer']), [
      'admin:self', 'admin:system:read', 'admin:workspace:read', 'admin:user:read'
    ]);
    assert.deepEqual(adminScopesForRoles(['platform-admin-auditor']), ['admin:self', 'admin:audit:read']);
    assert.ok(adminScopesForRoles(['platform-admin']).includes('admin:member:write'));
    assert.ok(!adminScopesForRoles(['platform-admin-viewer']).includes('admin:audit:read'));
    assert.ok(!adminScopesForRoles(['platform-admin-auditor']).includes('admin:user:read'));
  });

  it('uses a non-reversible session reference in audit records', () => {
    assert.equal(adminSessionReference('session-secret').length, 64);
    assert.notEqual(adminSessionReference('session-secret'), 'session-secret');
  });

  it('clears the host-only session cookie with its security attributes intact', () => {
    let cleared: { name: string; options: Record<string, unknown> } | undefined;
    clearAdminSessionCookie({
      clearCookie: (name: string, options: Record<string, unknown>) => { cleared = { name, options }; }
    } as never);
    assert.deepEqual(cleared, {
      name: config.ADMIN_SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      }
    });
  });
});
