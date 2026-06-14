import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { Role, WorkspaceInvitation, WorkspaceMembershipAuditAction } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import {
  AcceptWorkspaceInvitationResult,
  CreateWorkspaceInvitationResult,
  RevokeWorkspaceInvitationResult,
  UserRow,
  WorkspaceInvitationRow,
  WorkspaceMembershipRow,
  WorkspaceRow,
  mapWorkspaceInvitation,
  mapWorkspaceMembership
} from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from './repository-quotas.js';

export async function createWorkspaceInvitation(
  workspaceId: string,
  input: { email: string; role: Role; tokenHash: string; expiresAt: Date },
  actorUserId: string
): Promise<CreateWorkspaceInvitationResult> {
  const email = input.email.trim().toLowerCase();
  return withTransaction(async (client) => {
    const workspaceResult = await client.query<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE id = $1 LIMIT 1',
      [workspaceId]
    );
    if (!workspaceResult.rowCount) return { status: 'workspace_not_found' };

    const existingMember = await client.query(
      `SELECT 1
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND u.email = $2
       LIMIT 1`,
      [workspaceId, email]
    );
    if (existingMember.rowCount) return { status: 'already_member' };

    const invitationId = randomUUID();
    const result = await client.query<WorkspaceInvitationRow>(
      `INSERT INTO workspace_invitations (
         id, workspace_id, email, role, token_hash, invited_by, status, created_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), $7)
       RETURNING
         id, workspace_id, $8::text AS workspace_name, email, role, invited_by, status,
         accepted_by, created_at, expires_at, accepted_at, revoked_at`,
      [
        invitationId,
        workspaceId,
        email,
        input.role,
        input.tokenHash,
        actorUserId,
        input.expiresAt,
        workspaceResult.rows[0].name
      ]
    );
    const invitation = mapWorkspaceInvitation(result.rows[0]);
    await recordInvitationLifecycleAudit(client, {
      workspaceId,
      invitationId: invitation.id,
      invitationEmail: invitation.email,
      role: invitation.role,
      actorUserId,
      eventType: 'workspace.invitation.created.v1',
      summary: 'Workspace invitation created',
      expiresAt: invitation.expiresAt
    });
    return { status: 'created', invitation };
  });
}

export async function getWorkspaceInvitationByTokenHash(tokenHash: string): Promise<WorkspaceInvitation | null> {
  const result = await db.query<WorkspaceInvitationRow>(
    `SELECT
       i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.invited_by,
       CASE WHEN i.status = 'pending' AND i.expires_at <= NOW() THEN 'expired' ELSE i.status END AS status,
       i.accepted_by, i.created_at, i.expires_at, i.accepted_at, i.revoked_at
     FROM workspace_invitations i
     INNER JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  return mapWorkspaceInvitation(result.rows[0]);
}

export async function listWorkspaceInvitations(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: { createdAt: string; invitationId: string } | null;
    q?: string;
    role?: Role;
    status?: WorkspaceInvitation['status'];
    signature?: string;
  } = {}
): Promise<PagedResult<WorkspaceInvitation>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [workspaceId, limit + 1];
  const clauses = ['i.workspace_id = $1'];
  const statusSql = `CASE WHEN i.status = 'pending' AND i.expires_at <= NOW() THEN 'expired' ELSE i.status END`;
  if (options.role) {
    params.push(options.role);
    clauses.push(`i.role = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    clauses.push(`${statusSql} = $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q}%`);
    clauses.push(`(
      LOWER(i.email) LIKE $${params.length}
      OR LOWER(inviter.email) LIKE $${params.length}
      OR LOWER(inviter.display_name) LIKE $${params.length}
    )`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.invitationId);
    clauses.push(`(i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query<WorkspaceInvitationRow>(
    `SELECT
       i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.invited_by,
       ${statusSql} AS status,
       i.accepted_by, i.created_at, i.expires_at, i.accepted_at, i.revoked_at
     FROM workspace_invitations i
     INNER JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN users inviter ON inviter.id = i.invited_by
     WHERE ${clauses.join(' AND ')}
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map(mapWorkspaceInvitation), limit, (invitation) =>
    encodeCursor({
      signature: options.signature || '',
      createdAt: invitation.createdAt,
      invitationId: invitation.id
    })
  );
}

export async function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
  actorUserId: string
): Promise<RevokeWorkspaceInvitationResult> {
  return withTransaction(async (client) => {
    const currentResult = await client.query<WorkspaceInvitationRow>(
      `SELECT
         i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.invited_by,
         i.status, i.accepted_by, i.created_at, i.expires_at, i.accepted_at, i.revoked_at
       FROM workspace_invitations i
       INNER JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.workspace_id = $1 AND i.id = $2
       FOR UPDATE OF i`,
      [workspaceId, invitationId]
    );
    if (!currentResult.rowCount) return { status: 'not_found' };
    const current = currentResult.rows[0];
    if (current.status !== 'pending' || new Date(current.expires_at).getTime() <= Date.now()) {
      return { status: 'unavailable' };
    }

    const result = await client.query<WorkspaceInvitationRow>(
      `UPDATE workspace_invitations i
       SET status = 'revoked', revoked_at = NOW()
       FROM workspaces w
       WHERE i.workspace_id = $1
         AND i.id = $2
         AND i.status = 'pending'
         AND i.expires_at > NOW()
         AND w.id = i.workspace_id
       RETURNING
         i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.invited_by,
         i.status, i.accepted_by, i.created_at, i.expires_at, i.accepted_at, i.revoked_at`,
      [workspaceId, invitationId]
    );
    if (!result.rowCount) return { status: 'unavailable' };
    const invitation = mapWorkspaceInvitation(result.rows[0]);
    await recordInvitationLifecycleAudit(client, {
      workspaceId,
      invitationId: invitation.id,
      invitationEmail: invitation.email,
      role: invitation.role,
      actorUserId,
      eventType: 'workspace.invitation.revoked.v1',
      summary: 'Workspace invitation revoked'
    });
    return { status: 'revoked', invitation };
  });
}

async function recordInvitationMembershipAudit(
  client: PoolClient,
  data: {
    workspaceId: string;
    targetUserId: string;
    actorUserId: string;
    invitedBy: string;
    action: WorkspaceMembershipAuditAction;
    nextRole?: Role;
  }
): Promise<void> {
  await insertWorkspaceAuditEvent(
    {
      workspaceId: data.workspaceId,
      category: 'membership',
      eventType: 'workspace.member.added.v1',
      operation: 'write',
      actorUserId: data.actorUserId,
      objectType: 'member',
      objectId: data.targetUserId,
      summary: 'Workspace member added from invitation',
      metadata: {
        previousRole: null,
        nextRole: data.nextRole || null,
        source: 'invitation',
        invitedBy: data.invitedBy
      }
    },
    client
  );
}

async function recordInvitationLifecycleAudit(
  client: PoolClient,
  data: {
    workspaceId: string;
    invitationId: string;
    invitationEmail: string;
    role: Role;
    actorUserId: string;
    eventType: 'workspace.invitation.created.v1' | 'workspace.invitation.revoked.v1';
    summary: string;
    expiresAt?: string;
  }
): Promise<void> {
  await insertWorkspaceAuditEvent(
    {
      workspaceId: data.workspaceId,
      category: 'membership',
      eventType: data.eventType,
      operation: 'write',
      actorUserId: data.actorUserId,
      objectType: 'invitation',
      objectId: data.invitationId,
      objectName: data.invitationEmail,
      summary: data.summary,
      metadata: {
        email: data.invitationEmail,
        role: data.role,
        ...(data.expiresAt ? { expiresAt: data.expiresAt } : {})
      }
    },
    client
  );
}

export async function acceptWorkspaceInvitation(tokenHash: string, userId: string): Promise<AcceptWorkspaceInvitationResult> {
  return withTransaction(async (client) => {
    const invitationResult = await client.query<WorkspaceInvitationRow>(
      `SELECT
         i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.invited_by,
         i.status, i.accepted_by, i.created_at, i.expires_at, i.accepted_at, i.revoked_at
       FROM workspace_invitations i
       INNER JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token_hash = $1
       FOR UPDATE OF i`,
      [tokenHash]
    );
    if (!invitationResult.rowCount) return { status: 'not_found' };

    const invitation = invitationResult.rows[0];
    if (invitation.status !== 'pending') return { status: 'unavailable' };
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE workspace_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
        [invitation.id]
      );
      return { status: 'expired' };
    }

    const userResult = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 LIMIT 1 FOR UPDATE', [userId]);
    if (!userResult.rowCount) return { status: 'not_found' };
    const user = userResult.rows[0];
    if (user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
      return { status: 'email_mismatch', expectedEmail: invitation.email };
    }
    if (user.email_verification_required && !user.email_verified_at) {
      const passwordResult = await client.query(
        'SELECT 1 FROM user_password_credentials WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (passwordResult.rowCount) {
        return { status: 'email_unverified', email: user.email };
      }
    }

    const existingMembership = await client.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2
       LIMIT 1`,
      [invitation.workspace_id, userId]
    );
    if (existingMembership.rowCount) {
      await client.query(
        `UPDATE workspace_invitations SET status = 'accepted', accepted_by = $2, accepted_at = NOW() WHERE id = $1`,
        [invitation.id, userId]
      );
      return {
        status: 'accepted',
        member: mapWorkspaceMembership(existingMembership.rows[0]),
        workspaceId: invitation.workspace_id
      };
    }

    await assertWorkspaceMembershipQuota(client, userId);
    await assertWorkspaceMemberQuota(client, invitation.workspace_id);

    const membershipResult = await client.query<WorkspaceMembershipRow>(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, source, created_at, updated_at)
       VALUES ($1, $2, $3, 'internal', NOW(), NOW())
       RETURNING
         workspace_id, user_id, $4::text AS email, $5::text AS display_name,
         role, source, created_at, updated_at`,
      [invitation.workspace_id, userId, invitation.role, user.email, user.display_name]
    );

    await client.query(
      `UPDATE workspace_invitations SET status = 'accepted', accepted_by = $2, accepted_at = NOW() WHERE id = $1`,
      [invitation.id, userId]
    );
    await recordInvitationMembershipAudit(client, {
      workspaceId: invitation.workspace_id,
      targetUserId: userId,
      actorUserId: userId,
      invitedBy: invitation.invited_by,
      action: 'member_added',
      nextRole: invitation.role
    });

    return {
      status: 'accepted',
      member: mapWorkspaceMembership(membershipResult.rows[0]),
      workspaceId: invitation.workspace_id
    };
  });
}
