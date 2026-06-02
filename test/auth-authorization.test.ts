import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatScopes,
  hasEffectiveWorkspaceCapability,
  parseScopeString
} from '../src/auth/authorization.js';

describe('authorization helpers', () => {
  it('parses scopes and rejects unknown scope names', () => {
    const scopes = parseScopeString('read create_sessions read_target_logs manage_webhooks read');

    assert.deepEqual(scopes, ['read', 'create_sessions', 'read_target_logs', 'manage_webhooks']);
    assert.equal(formatScopes(scopes), 'read create_sessions read_target_logs manage_webhooks');
    assert.throws(() => parseScopeString('read unknown_scope'), /Invalid token scope/);
  });

  it('treats bearer token scopes as a restriction on workspace role capabilities', () => {
    const narrowToken = new Set(parseScopeString('read create_sessions'));
    const broadToken = new Set(parseScopeString('read create_read_write_runs'));

    assert.equal(hasEffectiveWorkspaceCapability('admin', 'manage_targets', narrowToken), false);
    assert.equal(hasEffectiveWorkspaceCapability('admin', 'create_sessions', narrowToken), true);
    assert.equal(hasEffectiveWorkspaceCapability('operator', 'create_read_write_runs', broadToken), false);
  });
});
