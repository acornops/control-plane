import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  adminWorkspaceDefaultCreateSchema,
  adminWorkspaceDefaultPatchSchema
} from '../src/types/contracts.js';
import {
  availabilityMatches,
  inheritedWorkspaceDefaultId,
  workspaceDefaultIdFromInheritedId
} from '../src/services/workspace-default-resolution.js';
import {
  validWorkspaceDefaultHttpsUrl,
  validWorkspaceDefaultSkillSource
} from '../src/controllers/admin-workspace-defaults-controller.js';
import { toAgentMcpServer } from '../src/services/agent-mcp-capabilities.js';

test('workspace default contracts accept only MCP servers and pinned skill bundles', () => {
  assert.equal(adminWorkspaceDefaultCreateSchema.safeParse({
    kind: 'mcp_server',
    name: 'GitHub',
    availableIn: ['virtual_machines', 'agents', 'kubernetes'],
    source: { type: 'https', endpoint: 'https://mcp.example.test' },
    reason: 'Approved platform default'
  }).success, true);
  const normalized = adminWorkspaceDefaultCreateSchema.parse({
    kind: 'mcp_server',
    name: 'GitHub',
    availableIn: ['virtual_machines', 'agents', 'kubernetes'],
    source: { type: 'https', endpoint: 'https://mcp.example.test' },
    reason: 'Approved platform default'
  });
  assert.deepEqual(normalized.availableIn, ['agents', 'kubernetes', 'virtual_machines']);
  assert.equal(adminWorkspaceDefaultCreateSchema.safeParse({
    kind: 'mcp_server',
    name: 'Unknown field',
    availableIn: ['agents'],
    source: { type: 'https', endpoint: 'https://mcp.example.test' },
    authentication: { type: 'bearer_token' },
    reason: 'Authentication belongs in the workspace'
  }).success, false);
  assert.equal(adminWorkspaceDefaultCreateSchema.safeParse({
    kind: 'skill',
    availableIn: ['agents'],
    source: {
      type: 'git',
      provider: 'github',
      repoUrl: 'https://github.com/acornops/skills',
      ref: 'main',
      commitSha: 'not-pinned'
    },
    files: [{ path: 'SKILL.md', content: '---\nname: test\n---\n' }],
    reason: 'Approved platform default'
  }).success, false);
  assert.equal(adminWorkspaceDefaultCreateSchema.safeParse({
    kind: 'skill',
    availableIn: ['agents'],
    source: {
      type: 'git',
      provider: 'github',
      repoUrl: 'https://github.com/acornops/skills',
      apiBaseUrl: 'https://github.example/api/v3',
      ref: 'main',
      commitSha: '0123456789abcdef0123456789abcdef01234567'
    },
    files: [{ path: 'SKILL.md', content: '---\nname: test\n---\n' }],
    reason: 'Custom API bases stay outside platform defaults'
  }).success, false);
  assert.equal(adminWorkspaceDefaultPatchSchema.safeParse({
    availableIn: ['kubernetes', 'virtual_machines'],
    reason: 'Change availability',
    source: { endpoint: 'https://replacement.example.test' }
  }).success, false);
  for (const availableIn of [
    [],
    ['agents', 'agents'],
    ['all'],
    ['kubernetes', 'unsupported']
  ]) {
    assert.equal(adminWorkspaceDefaultPatchSchema.safeParse({
      availableIn,
      reason: 'Reject invalid availability'
    }).success, false);
  }
  assert.equal(adminWorkspaceDefaultPatchSchema.safeParse({
    availableIn: 'agents',
    reason: 'Reject the replaced scalar contract'
  }).success, false);
});

test('availability expansion and inherited IDs are bounded', () => {
  assert.equal(availabilityMatches(['agents', 'kubernetes', 'virtual_machines'], 'agents'), true);
  assert.equal(availabilityMatches(['agents', 'kubernetes', 'virtual_machines'], 'kubernetes'), true);
  assert.equal(availabilityMatches(['agents', 'kubernetes', 'virtual_machines'], 'virtual_machine'), true);
  assert.equal(availabilityMatches(['agents'], 'kubernetes'), false);
  assert.equal(availabilityMatches(['kubernetes', 'virtual_machines'], 'kubernetes'), true);
  assert.equal(availabilityMatches(['kubernetes', 'virtual_machines'], 'virtual_machine'), true);
  const inherited = inheritedWorkspaceDefaultId('7cfb20ef');
  assert.equal(workspaceDefaultIdFromInheritedId(inherited), '7cfb20ef');
  assert.equal(workspaceDefaultIdFromInheritedId('workspace-owned'), null);
});

test('workspace initialization stores a detached snapshot without promotion bookkeeping', () => {
  const migration = readFileSync(
    new URL('../migrations/control-plane/003_workspace_defaults.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /CREATE TABLE workspace_initial_defaults/);
  assert.match(migration, /workspace_id TEXT NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /workspace_default_promotions/);
  assert.doesNotMatch(migration, /workspace_initial_defaults[\s\S]+REFERENCES workspace_defaults/);
  const repository = readFileSync(
    new URL('../src/store/repository-workspace-defaults.ts', import.meta.url),
    'utf8'
  );
  assert.match(repository, /available_in @> ARRAY\[\$\$\{params\.length\}\]::TEXT\[\]/);
  assert.match(repository, /INSERT INTO workspace_initial_defaults/);
  assert.match(repository, /FROM workspace_defaults/);
  assert.doesNotMatch(repository, /Promotion/);
  const provisioning = readFileSync(
    new URL('../src/services/workspace-provisioning.ts', import.meta.url),
    'utf8'
  );
  assert.match(provisioning, /if \(created\) await initializeWorkspaceDefaults\(client, workspaceId\)/);
});

test('platform default sources reject credential-bearing and private endpoints', () => {
  assert.ok(validWorkspaceDefaultHttpsUrl('https://mcp.example.com/v1/MCP'));
  for (const endpoint of [
    'http://mcp.example.com',
    'https://user:secret@mcp.example.com',
    'https://mcp.example.com/path?token=secret',
    'https://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://8.8.8.8/mcp',
    'https://[::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp'
  ]) {
    assert.equal(validWorkspaceDefaultHttpsUrl(endpoint), null, endpoint);
  }
  assert.equal(validWorkspaceDefaultSkillSource({
    provider: 'github',
    repoUrl: 'https://github.com/acornops/skills'
  }), true);
  assert.equal(validWorkspaceDefaultSkillSource({
    provider: 'github',
    repoUrl: 'https://gitlab.com/acornops/skills'
  }), false);
  assert.equal(validWorkspaceDefaultSkillSource({
    provider: 'gitlab',
    repoUrl: 'https://git.internal/acornops/skills'
  }), false);
});

test('materialized Agent defaults become normal workspace-owned items', () => {
  const mapped = toAgentMcpServer({
    id: 'server-1',
    workspace_id: 'workspace-1',
    agent_id: 'agent-1',
    scope_type: 'agent',
    target_type: 'agent',
    server_name: 'Platform MCP',
    server_url: 'https://mcp.example.com/service',
    enabled: true,
    auth_type: 'none',
    credential_mode: 'none',
    tools: [],
    inherited: false
  } as Parameters<typeof toAgentMcpServer>[0]);
  assert.equal(mapped.inherited, false);
  assert.equal(mapped.canDelete, true);
  assert.equal(mapped.canEditConnection, true);
});
