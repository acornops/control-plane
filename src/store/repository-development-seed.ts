import { DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_VM_ID, DEVELOPMENT_WORKSPACE_ID } from '../constants/dev-defaults.js';
import { db } from '../infra/db.js';
import { KUBERNETES_TARGET_TYPE, Role, VIRTUAL_MACHINE_TARGET_TYPE } from '../types/domain.js';
import { hashSecret, hashToken } from '../utils/crypto.js';
import { upsertTargetAgentRegistration } from './repository-target-agent-registrations.js';

export interface DevelopmentWorkspaceInvitationSeed {
  email: string;
  role: Role;
  status: 'pending' | 'expired';
  createdOffsetDays: number;
  expiresOffsetDays: number;
  token: string;
}

async function ensureDevelopmentWorkspaceMembership(userId: string, role: Role, resetRole: boolean): Promise<void> {
  const conflictClause = resetRole
    ? `DO UPDATE
       SET role = EXCLUDED.role,
           source = EXCLUDED.source,
           updated_at = NOW()`
    : 'DO NOTHING';
  await db.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) ${conflictClause}`,
    [DEVELOPMENT_WORKSPACE_ID, userId, role, 'oidc']
  );
}

async function ensureDevelopmentWorkspaceInvitation(
  invitation: DevelopmentWorkspaceInvitationSeed,
  invitedByUserId: string
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_invitations (
       id, workspace_id, email, role, token_hash, invited_by, status, created_at, expires_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       NOW() + ($8::int * INTERVAL '1 day'),
       NOW() + ($9::int * INTERVAL '1 day')
     )
     ON CONFLICT (id) DO UPDATE
     SET email = EXCLUDED.email,
         role = EXCLUDED.role,
         token_hash = EXCLUDED.token_hash,
         invited_by = EXCLUDED.invited_by,
         status = EXCLUDED.status,
         accepted_by = NULL,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         accepted_at = NULL,
         revoked_at = NULL`,
    [
      `dev-invite-${invitation.email}`,
      DEVELOPMENT_WORKSPACE_ID,
      invitation.email,
      invitation.role,
      hashToken(invitation.token),
      invitedByUserId,
      invitation.status,
      invitation.createdOffsetDays,
      invitation.expiresOffsetDays
    ]
  );
}

export async function ensureDevelopmentWorkspaceAndTargets(
  createdByUserId: string,
  seedAgentKey?: string,
  seedVmAgentKey?: string,
  additionalMemberships: Array<{ userId: string; role: Role }> = [],
  resetMembershipRoles = false,
  invitations: DevelopmentWorkspaceInvitationSeed[] = []
): Promise<void> {
  await db.query(
    `INSERT INTO workspaces (id, name, created_by, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [DEVELOPMENT_WORKSPACE_ID, 'Development Workspace', createdByUserId]
  );

  await ensureDevelopmentWorkspaceMembership(createdByUserId, 'owner', resetMembershipRoles);
  for (const membership of additionalMemberships) {
    await ensureDevelopmentWorkspaceMembership(membership.userId, membership.role, resetMembershipRoles);
  }
  for (const invitation of invitations) {
    await ensureDevelopmentWorkspaceInvitation(invitation, createdByUserId);
  }

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
     VALUES ($1, $2, 'kubernetes', $3, $4, '{}'::jsonb, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [DEVELOPMENT_CLUSTER_ID, DEVELOPMENT_WORKSPACE_ID, 'Development Cluster', 'offline', now, now]
  );
  await db.query(
    `INSERT INTO kubernetes_target_settings (target_id, namespace_include, namespace_exclude)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb)
     ON CONFLICT (target_id) DO NOTHING`,
    [DEVELOPMENT_CLUSTER_ID]
  );

  if (seedAgentKey) {
    await upsertTargetAgentRegistration({
      targetId: DEVELOPMENT_CLUSTER_ID,
      targetType: KUBERNETES_TARGET_TYPE,
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      agentKeyHash: hashSecret(seedAgentKey),
      keyVersion: 1
    });
  }

  await db.query(
    `INSERT INTO targets (id, workspace_id, target_type, name, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEVELOPMENT_VM_ID,
      DEVELOPMENT_WORKSPACE_ID,
      VIRTUAL_MACHINE_TARGET_TYPE,
      'Development Linux VM',
      'offline',
      JSON.stringify({
        hostname: 'acornops-dev-vm',
        osFamily: 'linux',
        serviceManager: 'systemd',
        environment: 'local',
        capabilities: ['read', 'logs', 'mcp', 'chat', 'systemd', 'linux']
      }),
      now,
      now
    ]
  );

  if (seedVmAgentKey) {
    await upsertTargetAgentRegistration({
      targetId: DEVELOPMENT_VM_ID,
      targetType: VIRTUAL_MACHINE_TARGET_TYPE,
      workspaceId: DEVELOPMENT_WORKSPACE_ID,
      agentKeyHash: hashSecret(seedVmAgentKey),
      keyVersion: 1
    });
  }
}
