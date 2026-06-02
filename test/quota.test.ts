import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { applyWorkspaceSummaryPermissions } from '../src/controllers/workspaces-controller.js';
import { db } from '../src/infra/db.js';
import { addCluster } from '../src/store/repository-kubernetes-clusters.js';
import { mapWorkspaceSummary } from '../src/store/repository-mappers.js';
import {
  assertWorkspaceMemberQuota,
  assertWorkspaceTargetQuota,
  getUserQuotaForUser,
  QuotaExceededError,
  resolveWorkspacePlan
} from '../src/store/repository-quotas.js';
import { addVirtualMachine } from '../src/store/repository-virtual-machines.js';
import { addWorkspaceMember } from '../src/store/repository-workspaces.js';
import { acceptWorkspaceInvitation } from '../src/store/repository-invitations.js';
import { addWorkspace } from '../src/store/repository-users.js';

afterEach(() => {
  mock.restoreAll();
});

function transactionClient(handler: (sql: string, params?: unknown[]) => { rowCount: number; rows: unknown[] }) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      return handler(sql, params);
    },
    release: () => undefined
  };
  mock.method(db, 'connect', async () => client);
  return { statements };
}

function workspaceRow() {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    created_by: 'user-1',
    plan_key: 'default',
    created_at: '2026-06-01T00:00:00.000Z'
  };
}

describe('quota usage payloads', () => {
  it('resolves only configured workspace plans', () => {
    assert.equal(resolveWorkspacePlan('default').quotas.members, 100);
    assert.throws(() => resolveWorkspacePlan('plus'), /Unknown workspace plan: plus/);
  });

  it('/me quota usage is counted from workspace memberships', async () => {
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      assert.match(sql, /COUNT\(\*\)::int AS count FROM workspace_memberships/);
      assert.deepEqual(params, ['user-1']);
      return { rowCount: 1, rows: [{ count: 7 }] };
    });

    const quota = await getUserQuotaForUser('user-1');

    assert.deepEqual(quota, { workspaceMemberships: { used: 7, limit: 50 } });
  });

  it('workspace summaries include Kubernetes and VM quota and redact operational usage for auditors', () => {
    const ownerSummary = mapWorkspaceSummary({
      ...workspaceRow(),
      current_user_role: 'owner',
      cluster_count: 4,
      virtual_machine_count: 5,
      member_count: 2
    });
    const auditorSummary = mapWorkspaceSummary({
      ...workspaceRow(),
      current_user_role: 'auditor',
      cluster_count: 4,
      virtual_machine_count: 5,
      member_count: 2
    });

    assert.deepEqual(ownerSummary.quota, {
      members: { used: 2, limit: 100 },
      kubernetesClusters: { used: 4, limit: 30 },
      virtualMachines: { used: 5, limit: 30 }
    });
    assert.deepEqual(ownerSummary.plan, { key: 'default', name: 'Default' });
    assert.deepEqual(auditorSummary.quota, {
      members: { used: 2, limit: 100 },
      kubernetesClusters: { used: 0, limit: 30 },
      virtualMachines: { used: 0, limit: 30 }
    });
  });

  it('redacts operational usage after effective workspace permissions are narrowed', () => {
    const ownerSummary = mapWorkspaceSummary({
      ...workspaceRow(),
      current_user_role: 'owner',
      cluster_count: 4,
      virtual_machine_count: 5,
      member_count: 2
    });
    const restricted = applyWorkspaceSummaryPermissions(ownerSummary, {
      ...ownerSummary.permissions,
      read_workspace_data: false
    });

    assert.equal(restricted.clusterCount, 0);
    assert.deepEqual(restricted.quota, {
      members: { used: 2, limit: 100 },
      kubernetesClusters: { used: 0, limit: 30 },
      virtualMachines: { used: 0, limit: 30 }
    });
  });

  it('redacts member usage after effective member permissions are narrowed', () => {
    const ownerSummary = mapWorkspaceSummary({
      ...workspaceRow(),
      current_user_role: 'owner',
      cluster_count: 4,
      virtual_machine_count: 5,
      member_count: 2
    });
    const restricted = applyWorkspaceSummaryPermissions(ownerSummary, {
      ...ownerSummary.permissions,
      read_members: false
    });

    assert.equal(restricted.memberCount, 0);
    assert.deepEqual(restricted.quota, {
      members: { used: 0, limit: 100 },
      kubernetesClusters: { used: 4, limit: 30 },
      virtualMachines: { used: 5, limit: 30 }
    });
  });
});

describe('quota enforcement', () => {
  it('creating a workspace succeeds when the user has 49 memberships', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('user_id')) return { rowCount: 1, rows: [{ count: 49 }] };
      if (sql.includes('INSERT INTO workspaces')) return { rowCount: 1, rows: [workspaceRow()] };
      if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('workspace_id')) return { rowCount: 1, rows: [{ count: 0 }] };
      if (sql.includes('INSERT INTO workspace_memberships')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const workspace = await addWorkspace('Workspace', 'user-1');

    assert.equal(workspace.name, 'Workspace');
    assert.equal(statements[1], 'SELECT id FROM users WHERE id = $1 FOR UPDATE');
    assert.match(statements[2], /COUNT\(\*\)::int AS count FROM workspace_memberships/);
    assert.equal(statements.at(-1), 'COMMIT');
  });

  it('creating a workspace fails at the membership limit before inserting rows', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships')) return { rowCount: 1, rows: [{ count: 50 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => addWorkspace('Workspace', 'user-1'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'workspaceMemberships'
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO workspaces')), false);
  });

  it('adding an existing member returns the existing-member conflict before quota checks', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT 1 FROM workspaces')) return { rowCount: 1, rows: [{ exists: 1 }] };
      if (sql.includes('INSERT INTO users')) return { rowCount: 1, rows: [{ id: 'user-2', email: 'new@example.test', display_name: 'New User' }] };
      if (sql.includes('FROM workspace_memberships') && sql.includes('LIMIT 1')) return { rowCount: 1, rows: [{ exists: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await addWorkspaceMember('workspace-1', { email: 'new@example.test', role: 'viewer' }, 'admin-1');

    assert.deepEqual(result, { status: 'already_exists' });
    assert.equal(statements.some((sql) => sql.includes('COUNT(*)::int AS count FROM workspace_memberships')), false);
  });

  it('adding a member fails when the target user is at the membership limit', async () => {
    transactionClient((sql) => {
      if (sql.includes('SELECT 1 FROM workspaces')) return { rowCount: 1, rows: [{ exists: 1 }] };
      if (sql.includes('INSERT INTO users')) return { rowCount: 1, rows: [{ id: 'user-2', email: 'new@example.test', display_name: 'New User' }] };
      if (sql.includes('FROM workspace_memberships') && sql.includes('LIMIT 1')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-2' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships')) return { rowCount: 1, rows: [{ count: 50 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => addWorkspaceMember('workspace-1', { email: 'new@example.test', role: 'viewer' }, 'admin-1'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'workspaceMemberships'
    );
  });

  it('adding a member fails when the workspace is at the member limit', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT 1 FROM workspaces')) return { rowCount: 1, rows: [{ exists: 1 }] };
      if (sql.includes('INSERT INTO users')) return { rowCount: 1, rows: [{ id: 'user-2', email: 'new@example.test', display_name: 'New User' }] };
      if (sql.includes('FROM workspace_memberships') && sql.includes('LIMIT 1')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-2' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('user_id')) return { rowCount: 1, rows: [{ count: 49 }] };
      if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('workspace_id')) return { rowCount: 1, rows: [{ count: 100 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => addWorkspaceMember('workspace-1', { email: 'new@example.test', role: 'viewer' }, 'admin-1'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'workspaceMembers'
    );
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO workspace_memberships')), false);
  });

  it('accepting an invitation fails at the membership limit and leaves the invitation pending', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('FROM workspace_invitations i')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'invite-1',
            workspace_id: 'workspace-1',
            workspace_name: 'Workspace',
            email: 'invitee@example.test',
            role: 'viewer',
            invited_by: 'admin-1',
            status: 'pending',
            accepted_by: null,
            created_at: '2026-06-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
            accepted_at: null,
            revoked_at: null
          }]
        };
      }
      if (sql.includes('SELECT * FROM users')) return { rowCount: 1, rows: [{ id: 'user-2', email: 'invitee@example.test', display_name: 'Invitee' }] };
      if (sql.includes('FROM workspace_memberships m')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-2' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('user_id')) return { rowCount: 1, rows: [{ count: 50 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => acceptWorkspaceInvitation('token-hash', 'user-2'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'workspaceMemberships'
    );
    assert.equal(statements.some((sql) => sql.includes('UPDATE workspace_invitations SET status')), false);
  });

  it('accepting an invitation fails at the workspace member limit and leaves the invitation pending', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('FROM workspace_invitations i')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'invite-1',
            workspace_id: 'workspace-1',
            workspace_name: 'Workspace',
            email: 'invitee@example.test',
            role: 'viewer',
            invited_by: 'admin-1',
            status: 'pending',
            accepted_by: null,
            created_at: '2026-06-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
            accepted_at: null,
            revoked_at: null
          }]
        };
      }
      if (sql.includes('SELECT * FROM users')) return { rowCount: 1, rows: [{ id: 'user-2', email: 'invitee@example.test', display_name: 'Invitee' }] };
      if (sql.includes('FROM workspace_memberships m')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-2' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('user_id')) return { rowCount: 1, rows: [{ count: 49 }] };
      if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('workspace_id')) return { rowCount: 1, rows: [{ count: 100 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => acceptWorkspaceInvitation('token-hash', 'user-2'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'workspaceMembers'
    );
    assert.equal(statements.some((sql) => sql.includes('UPDATE workspace_invitations SET status')), false);
  });

  it('locks workspace rows before counting workspace member quota', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
        if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
        if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships')) return { rowCount: 1, rows: [{ count: 49 }] };
        throw new Error(`Unexpected query: ${sql}`);
      }
    };

    await assertWorkspaceMemberQuota(client as never, 'workspace-1');

    assert.equal(statements[0], 'SELECT plan_key FROM workspaces WHERE id = $1 FOR UPDATE');
    assert.match(statements[1], /FROM workspace_quota_overrides/);
    assert.match(statements[2], /COUNT\(\*\)::int AS count FROM workspace_memberships/);
  });

  it('locks workspace rows before counting target quota', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
        if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
        if (sql.includes('COUNT(*)::int AS count FROM targets')) return { rowCount: 1, rows: [{ count: 29 }] };
        throw new Error(`Unexpected query: ${sql}`);
      }
    };

    await assertWorkspaceTargetQuota(client as never, 'workspace-1', 'kubernetes');

    assert.equal(statements[0], 'SELECT plan_key FROM workspaces WHERE id = $1 FOR UPDATE');
    assert.match(statements[1], /FROM workspace_quota_overrides/);
    assert.match(statements[2], /COUNT\(\*\)::int AS count FROM targets/);
  });

  it('registering the 31st Kubernetes cluster fails before inserting a target', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('COUNT(*)::int AS count FROM targets')) return { rowCount: 1, rows: [{ count: 30 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => addCluster('workspace-1', 'cluster-31'),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'kubernetesClusters'
    );
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO targets')), false);
  });

  it('registering the 31st VM fails before inserting a target', async () => {
    const { statements } = transactionClient((sql) => {
      if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('COUNT(*)::int AS count FROM targets')) return { rowCount: 1, rows: [{ count: 30 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      () => addVirtualMachine('workspace-1', { name: 'vm-31' }),
      (error) => error instanceof QuotaExceededError && error.quotaKey === 'virtualMachines'
    );
    assert.equal(statements.some((sql) => sql.includes('INSERT INTO targets')), false);
  });
});
