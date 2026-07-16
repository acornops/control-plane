import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BUILT_IN_ROLE_TEMPLATES,
  configureRoleTemplates,
  getWorkspacePermissions
} from '../src/auth/authorization.js';
import {
  getEffectiveWorkspacePermissions,
  getWorkspaceAuthorization,
  requireWorkspaceCapability,
  requireWorkspaceRead
} from '../src/auth/workspace-authorization.js';
import { canManageMembership } from '../src/controllers/workspaces/common.js';
import { repo } from '../src/store/repository.js';
import type { Role, RoleTemplate } from '../src/types/domain.js';

const originalGetWorkspaceRole = repo.getWorkspaceRole;
const originalGetExternalIntegrationWorkspaceGrant = repo.getExternalIntegrationWorkspaceGrant;

afterEach(() => {
  repo.getWorkspaceRole = originalGetWorkspaceRole;
  repo.getExternalIntegrationWorkspaceGrant = originalGetExternalIntegrationWorkspaceGrant;
  configureRoleTemplates(Object.values(BUILT_IN_ROLE_TEMPLATES));
});

function createRequest(userId = 'user-1') {
  return {
    auth: {
      userId,
      credential: { type: 'session' as const, sessionId: 'session-1' }
    }
  };
}

function createExternalIntegrationRequest(userId = 'user-1') {
  return {
    auth: {
      userId,
      credential: {
        type: 'external_integration' as const,
        linkId: 'link-1',
        integrationId: 'external-chat',
        provider: 'external',
        externalUserId: 'external-user-1'
      }
    }
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe('workspace authorization helpers', () => {
  function installExternalIntegrationGrant(capabilities = ['read_workspace_data', 'create_sessions', 'create_read_only_runs'] as const): void {
    repo.getExternalIntegrationWorkspaceGrant = async () => ({
      workspaceId: 'workspace-1',
      capabilities: [...capabilities],
      grantedByUserId: 'user-1',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z'
    });
  }
  it('allows viewers to read but not mutate', async () => {
    repo.getWorkspaceRole = async () => 'viewer';
    const req = createRequest();
    const res = createResponse();

    const readAuthz = await requireWorkspaceRead(req as never, res as never, 'workspace-1');
    assert.equal(readAuthz?.role, 'viewer');
    assert.equal(readAuthz?.can('manage_targets'), false);

    const mutationAuthz = await requireWorkspaceCapability(
      req as never,
      res as never,
      'workspace-1',
      'manage_targets',
      'denied'
    );
    assert.equal(mutationAuthz, null);
    assert.equal(res.statusCode, 403);
  });

  it('uses the capability denial message for configured read denial cases', async () => {
    repo.getWorkspaceRole = async () => null;
    const res = createResponse();

    const authz = await requireWorkspaceCapability(
      createRequest() as never,
      res as never,
      'workspace-1',
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );

    assert.equal(authz, null);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: {
        code: 'FORBIDDEN',
        message: 'Only workspace roles with member-management capability can manage members',
        retryable: false
      }
    });
  });

  it('grants operators troubleshooting and log capabilities without read-write runs', async () => {
    repo.getWorkspaceRole = async () => 'operator';
    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz?.can('create_sessions'), true);
    assert.equal(authz?.can('create_read_only_runs'), true);
    assert.equal(authz?.can('read_target_logs'), true);
    assert.equal(authz?.can('cancel_runs'), true);
    assert.equal(authz?.can('create_read_write_runs'), false);
  });

  it('grants admins management capabilities except workspace deletion', async () => {
    repo.getWorkspaceRole = async () => 'admin';
    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz?.can('manage_targets'), true);
    assert.equal(authz?.can('manage_mcp'), true);
    assert.equal(authz?.can('manage_tools'), true);
    assert.equal(authz?.can('manage_skills'), true);
    assert.equal(authz?.can('manage_agent_keys'), true);
    assert.equal(authz?.can('manage_webhooks'), true);
    assert.equal(authz?.can('delete_workspace'), false);
  });

  it('allows owners to delete workspaces', async () => {
    repo.getWorkspaceRole = async () => 'owner';
    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz?.can('delete_workspace'), true);
  });

  it('limits auditors to audit and membership reads', async () => {
    repo.getWorkspaceRole = async () => 'auditor';
    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz?.can('read_audit_log'), true);
    assert.equal(authz?.can('read_members'), true);
    assert.equal(authz?.can('read_workspace_data'), false);
    assert.equal(authz?.can('manage_members'), false);
    assert.equal(authz?.can('manage_webhooks'), false);
    assert.equal(authz?.can('create_sessions'), false);
  });

  it('returns null when the user has no workspace membership', async () => {
    repo.getWorkspaceRole = async () => null;
    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz, null);
  });

  it('fails closed when a membership uses an unsupported role key', async () => {
    repo.getWorkspaceRole = async () => 'retired_role';
    const res = createResponse();

    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');
    const readAuthz = await requireWorkspaceRead(createRequest() as never, res as never, 'workspace-1');

    assert.equal(authz, null);
    assert.equal(readAuthz, null);
    assert.equal(res.statusCode, 403);
  });

  it('allows custom member managers to manage only unprotected roles', async () => {
    const memberManager: RoleTemplate = {
      key: 'member_manager',
      displayName: 'Member Manager',
      description: 'Manages ordinary workspace memberships.',
      kind: 'custom',
      capabilities: ['read_members', 'manage_members'],
      protected: false,
      sortOrder: 250
    };
    configureRoleTemplates([...Object.values(BUILT_IN_ROLE_TEMPLATES), memberManager]);
    repo.getWorkspaceRole = async () => 'member_manager';

    const authz = await getWorkspaceAuthorization(createRequest() as never, 'workspace-1');

    assert.equal(authz?.can('manage_members'), true);
    assert.equal(canManageMembership('member_manager', 'viewer', 'operator'), true);
    assert.equal(canManageMembership('member_manager', 'owner', 'viewer'), false);
    assert.equal(canManageMembership('member_manager', 'viewer', 'auditor'), false);
    assert.equal(canManageMembership('viewer', 'viewer', 'operator'), false);
    assert.equal(canManageMembership('member_manager', 'retired_role', 'viewer'), false);
    assert.equal(canManageMembership('retired_role', 'viewer', 'operator'), false);
  });

  it('keeps session effective permissions equal to role permissions', async () => {
    const req = createRequest();
    for (const role of ['owner', 'admin', 'operator', 'viewer', 'auditor'] as Role[]) {
      assert.deepEqual(await getEffectiveWorkspacePermissions(req as never, role, 'workspace-1'), getWorkspacePermissions(role));
    }
  });

  it('limits external integration effective permissions to bot-allowed reads and read-only troubleshooting', async () => {
    installExternalIntegrationGrant();
    const req = createExternalIntegrationRequest();
    const permissions = await getEffectiveWorkspacePermissions(req as never, 'owner', 'workspace-1');
    assert.ok(permissions);
    const botAllowedCapabilities = new Set(['read_workspace_data', 'create_sessions', 'create_read_only_runs']);

    for (const capability of Object.keys(permissions) as Array<keyof typeof permissions>) {
      assert.equal(permissions[capability], botAllowedCapabilities.has(capability), capability);
    }
  });

  it('intersects external integration permissions with the linked user workspace role', async () => {
    installExternalIntegrationGrant();
    const req = createExternalIntegrationRequest();
    const auditorPermissions = await getEffectiveWorkspacePermissions(req as never, 'auditor', 'workspace-1');
    assert.ok(auditorPermissions);

    for (const capability of Object.keys(auditorPermissions) as Array<keyof typeof auditorPermissions>) {
      assert.equal(auditorPermissions[capability], false, capability);
    }

    const viewerPermissions = await getEffectiveWorkspacePermissions(req as never, 'viewer', 'workspace-1');
    assert.ok(viewerPermissions);
    for (const capability of Object.keys(viewerPermissions) as Array<keyof typeof viewerPermissions>) {
      assert.equal(viewerPermissions[capability], capability === 'read_workspace_data', capability);
    }
  });

  it('denies external integration effective permissions without a workspace grant', async () => {
    repo.getExternalIntegrationWorkspaceGrant = async () => null;
    const permissions = await getEffectiveWorkspacePermissions(createExternalIntegrationRequest() as never, 'owner', 'workspace-1');
    assert.equal(permissions, null);
  });

  it('denies privileged workspace capabilities to external integration credentials even for owner memberships', async () => {
    installExternalIntegrationGrant();
    repo.getWorkspaceRole = async () => 'owner';
    const req = createExternalIntegrationRequest();
    const res = createResponse();

    const authz = await getWorkspaceAuthorization(req as never, 'workspace-1');
    assert.equal(authz?.role, 'owner');
    assert.equal(authz?.can('delete_workspace'), false);
    assert.equal(authz?.can('read_workspace_data'), true);
    assert.equal(authz?.can('read_members'), false);
    assert.equal(authz?.can('create_sessions'), true);
    assert.equal(authz?.can('create_read_only_runs'), true);
    assert.equal(authz?.can('create_read_write_runs'), false);
    assert.equal(authz?.can('read_target_logs'), false);
    assert.equal(authz?.can('cancel_runs'), false);

    const mutationAuthz = await requireWorkspaceCapability(
      req as never,
      res as never,
      'workspace-1',
      'delete_workspace',
      'denied'
    );
    assert.equal(mutationAuthz, null);
    assert.equal(res.statusCode, 403);
  });
});
