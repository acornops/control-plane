import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertExternalIntegrationWorkspaceCapabilities,
  formatScopes,
  groupWorkspaceCapabilities,
  hasEffectiveWorkspaceCapability,
  listConfiguredRoleTemplates,
  parseScopeString,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_CAPABILITY_METADATA
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

  it('requires session creation when external integrations allow run creation', () => {
    assert.deepEqual(
      assertExternalIntegrationWorkspaceCapabilities([
        'read_workspace_data',
        'create_sessions',
        'create_read_write_runs'
      ]),
      ['read_workspace_data', 'create_sessions', 'create_read_write_runs']
    );
    assert.throws(
      () => assertExternalIntegrationWorkspaceCapabilities(['read_workspace_data', 'create_read_write_runs']),
      /create_read_write_runs requires create_sessions/
    );
  });

  it('defines display metadata for every workspace capability', () => {
    assert.deepEqual(
      Object.keys(WORKSPACE_CAPABILITY_METADATA).sort(),
      [...WORKSPACE_CAPABILITIES].sort()
    );
  });

  it('groups role-template capabilities for client display', () => {
    assert.deepEqual(groupWorkspaceCapabilities([
      'manage_members',
      'read_workspace_data',
      'create_sessions',
      'read_members'
    ]), [
      { key: 'workspace', sortOrder: 0, capabilities: ['read_workspace_data'] },
      { key: 'members', sortOrder: 100, capabilities: ['read_members', 'manage_members'] },
      { key: 'operations', sortOrder: 300, capabilities: ['create_sessions'] }
    ]);

    const owner = listConfiguredRoleTemplates().find((template) => template.key === 'owner');
    assert.ok(owner);
    assert.ok(owner.capabilityGroups?.some((group) => group.key === 'settings' && group.capabilities.includes('manage_agent_keys')));
  });
});
