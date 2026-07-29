import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  resolveAgentSkillDefaults,
  resolveMcpServerDefaults,
  resolveTargetSkillDefaults
} from '../src/services/workspace-default-resolution.js';
import { provisionWorkspaceWithStarterAutomation } from '../src/services/workspace-provisioning.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const hasIsolatedDatabase = Boolean(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
const allDestinations = ['agents', 'kubernetes', 'virtual_machines'];

describe('workspace default initialization', { skip: !hasIsolatedDatabase }, () => {
  beforeEach(async () => {
    await resetAutomationDatabaseFixtures();
    await db.query('TRUNCATE TABLE workspace_defaults CASCADE');
  });

  after(closeAutomationDatabaseFixtures);

  it('copies current defaults once and projects them disabled to every selected destination', async () => {
    await db.query(
      `INSERT INTO workspace_defaults (
         id, kind, name, description, available_in, source,
         content_digest, created_by, updated_by
       ) VALUES
         (
           'default-mcp', 'mcp_server', 'Platform MCP', '',
           $1::text[], $2::jsonb, NULL, 'user-1', 'user-1'
         ),
         (
           'default-skill', 'skill', 'Platform Skill', 'A pinned test skill.',
           $1::text[], $3::jsonb, 'sha256:bundle', 'user-1', 'user-1'
         )`,
      [
        allDestinations,
        JSON.stringify({ type: 'https', endpoint: 'https://mcp.example.test/service' }),
        JSON.stringify({
          type: 'git',
          provider: 'github',
          repoUrl: 'https://github.com/acornops/skills',
          ref: 'main',
          subpath: 'skills/platform-test',
          commitSha: '0123456789abcdef0123456789abcdef01234567'
        })
      ]
    );
    const skillContent = '---\nname: platform-test\n---\n';
    await db.query(
      `INSERT INTO workspace_default_skill_files (
         default_id, path, content, content_digest, size_bytes
       ) VALUES (
         'default-skill', 'SKILL.md', $1, 'sha256:file', $2
       )`,
      [skillContent, Buffer.byteLength(skillContent)]
    );

    const provisioned = await provisionWorkspaceWithStarterAutomation({
      id: 'workspace-after-defaults',
      name: 'Workspace After Defaults',
      createdBy: 'user-1',
      enforceQuotas: false
    });
    assert.equal(provisioned.created, true);

    const agentMcp = await resolveMcpServerDefaults([], 'agents', {
      workspaceId: 'workspace-after-defaults',
      destinationId: 'agent-1'
    });
    const kubernetesMcp = await resolveMcpServerDefaults([], 'kubernetes', {
      workspaceId: 'workspace-after-defaults',
      destinationId: 'cluster-1'
    });
    const virtualMachineMcp = await resolveMcpServerDefaults([], 'virtual_machine', {
      workspaceId: 'workspace-after-defaults',
      destinationId: 'vm-1'
    });
    for (const [destination, items] of [
      ['Agents', agentMcp],
      ['Kubernetes', kubernetesMcp],
      ['Virtual machines', virtualMachineMcp]
    ] as const) {
      assert.equal(items.length, 1, `${destination} should receive the MCP default`);
      assert.equal(items[0].server_name, 'Platform MCP');
      assert.equal(items[0].enabled, false);
      assert.equal(items[0].inherited, true);
    }

    const agentSkills = await resolveAgentSkillDefaults([], {
      workspaceId: 'workspace-after-defaults',
      agentId: 'agent-1'
    });
    const kubernetesSkills = await resolveTargetSkillDefaults([], 'kubernetes', {
      workspaceId: 'workspace-after-defaults',
      targetId: 'cluster-1'
    });
    const virtualMachineSkills = await resolveTargetSkillDefaults([], 'virtual_machine', {
      workspaceId: 'workspace-after-defaults',
      targetId: 'vm-1'
    });
    for (const [destination, items] of [
      ['Agents', agentSkills],
      ['Kubernetes', kubernetesSkills],
      ['Virtual machines', virtualMachineSkills]
    ] as const) {
      assert.equal(items.length, 1, `${destination} should receive the skill default`);
      assert.equal(items[0].name, 'Platform Skill');
      assert.equal(items[0].enabled, false);
      assert.equal(items[0].inherited, true);
    }
    assert.equal(agentSkills[0].files[0].path, 'SKILL.md');
    assert.equal(kubernetesSkills[0].bundleStats.fileCount, 1);

    assert.deepEqual(
      await resolveMcpServerDefaults([], 'agents', {
        workspaceId: 'workspace-1',
        destinationId: 'existing-agent'
      }),
      [],
      'a workspace created before the defaults must remain unchanged'
    );

    await db.query('DELETE FROM workspace_defaults');
    assert.equal(
      (await resolveMcpServerDefaults([], 'agents', {
        workspaceId: 'workspace-after-defaults',
        destinationId: 'agent-1'
      })).length,
      1,
      'removing a platform default must not mutate an existing workspace snapshot'
    );

    await provisionWorkspaceWithStarterAutomation({
      id: 'workspace-after-removal',
      name: 'Workspace After Removal',
      createdBy: 'user-1',
      enforceQuotas: false
    });
    assert.deepEqual(
      await resolveAgentSkillDefaults([], {
        workspaceId: 'workspace-after-removal',
        agentId: 'agent-2'
      }),
      [],
      'a later workspace must use the current empty platform list'
    );
  });
});
