import { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import {
  Role,
  WorkspaceMemberCandidate,
  WorkspaceMemberDiscoveryMode,
  WorkspaceMembership,
  WorkspaceMembershipAuditAction
} from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import {
  AddWorkspaceMemberResult,
  DeleteWorkspaceMemberResult,
  UpdateWorkspaceMemberResult,
  WorkspaceMembershipRow,
  mapWorkspaceMembership,
  normalizeRole
} from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from './repository-quotas.js';

export async function listWorkspaceMembers(
    workspaceId: string,
    options: {
      limit?: number;
      cursor?: { roleRank: number; email: string; userId: string } | null;
      q?: string;
      role?: Role;
      source?: WorkspaceMembership['source'];
      signature?: string;
    } = {}
  ): Promise<PagedResult<WorkspaceMembership>> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const params: Array<string | number> = [workspaceId, limit + 1];
    const clauses = ['m.workspace_id = $1'];
    if (options.role) {
      params.push(options.role);
      clauses.push(`m.role = $${params.length}`);
    }
    if (options.source) {
      params.push(options.source);
      clauses.push(`m.source = $${params.length}`);
    }
    if (options.q) {
      params.push(`%${options.q}%`);
      clauses.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(u.display_name) LIKE $${params.length})`);
    }
    if (options.cursor) {
      params.push(options.cursor.roleRank, options.cursor.email, options.cursor.userId);
      clauses.push(`(
        COALESCE(rt.sort_order, 10000),
        u.email,
        m.user_id
      ) > ($${params.length - 2}::int, $${params.length - 1}::text, $${params.length}::text)`);
    }
    const result = await db.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       LEFT JOIN role_templates rt ON rt.key = m.role
       WHERE ${clauses.join(' AND ')}
       ORDER BY
         COALESCE(rt.sort_order, 10000),
         u.email ASC,
         m.user_id ASC
       LIMIT $2`,
      params
    );
    return pageWithCursor(result.rows.map(mapWorkspaceMembership), limit, (member) =>
      encodeCursor({
        signature: options.signature || '',
        roleRank: member.roleTemplate?.sortOrder ?? 10000,
        email: member.email,
        userId: member.userId
      })
    );
  }
export async function getWorkspaceMember(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const result = await db.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2
       LIMIT 1`,
      [workspaceId, userId]
    );
    if (!result.rowCount) return null;
    return mapWorkspaceMembership(result.rows[0]);
  }

interface WorkspaceMemberCandidateRow {
  user_id: string;
  email: string;
  display_name: string;
  has_oidc: boolean;
  has_password: boolean;
  status: WorkspaceMemberCandidate['status'];
}

export async function listWorkspaceMemberCandidates(
  workspaceId: string,
  query: string,
  mode: Exclude<WorkspaceMemberDiscoveryMode, 'disabled'>,
  limit = 8
): Promise<WorkspaceMemberCandidate[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const boundedLimit = Math.max(1, Math.min(20, limit));
  const matchSql = mode === 'exact_email'
    ? 'LOWER(u.email) = $2'
    : '(STRPOS(LOWER(u.email), $2) > 0 OR STRPOS(LOWER(u.display_name), $2) > 0)';
  const result = await db.query<WorkspaceMemberCandidateRow>(
    `SELECT
       u.id AS user_id,
       u.email,
       u.display_name,
       EXISTS (
         SELECT 1 FROM user_federated_identities fi
         WHERE fi.user_id = u.id AND fi.last_login_at IS NOT NULL
       ) AS has_oidc,
       EXISTS (
         SELECT 1 FROM user_password_credentials pc
         WHERE pc.user_id = u.id
           AND (u.email_verification_required = false OR u.email_verified_at IS NOT NULL)
       ) AS has_password,
       CASE
         WHEN m.user_id IS NOT NULL THEN 'member'
         WHEN EXISTS (
           SELECT 1
           FROM workspace_invitations i
           WHERE i.workspace_id = $1
             AND LOWER(i.email) = LOWER(u.email)
             AND i.status = 'pending'
             AND i.expires_at > NOW()
         ) THEN 'invited'
         ELSE 'available'
       END AS status
     FROM users u
     LEFT JOIN workspace_memberships m
       ON m.workspace_id = $1 AND m.user_id = u.id
     WHERE ${matchSql}
       AND (
         EXISTS (
           SELECT 1 FROM user_password_credentials pc
           WHERE pc.user_id = u.id
             AND (u.email_verification_required = false OR u.email_verified_at IS NOT NULL)
         )
         OR EXISTS (
           SELECT 1 FROM user_federated_identities fi
           WHERE fi.user_id = u.id AND fi.last_login_at IS NOT NULL
         )
       )
     ORDER BY
       CASE WHEN LOWER(u.email) = $3 THEN 0 ELSE 1 END,
       LOWER(u.display_name),
       LOWER(u.email),
       u.id
     LIMIT $4`,
    [workspaceId, normalizedQuery, normalizedQuery, boundedLimit]
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    authMethods: [
      ...(row.has_oidc ? ['oidc' as const] : []),
      ...(row.has_password ? ['password' as const] : [])
    ],
    status: row.status
  }));
}
async function recordWorkspaceMembershipAudit(
    client: PoolClient,
    data: {
      workspaceId: string;
      targetUserId: string;
      actorUserId: string;
      action: WorkspaceMembershipAuditAction;
      previousRole?: Role;
      nextRole?: Role;
    }
  ): Promise<void> {
    const eventType =
      data.action === 'member_added'
        ? 'workspace.member.added.v1'
        : data.action === 'member_role_updated'
          ? 'workspace.member.role_updated.v1'
          : 'workspace.member.removed.v1';
    const summary =
      data.action === 'member_added'
        ? 'Workspace member added'
        : data.action === 'member_role_updated'
          ? 'Workspace member role updated'
          : 'Workspace member removed';
    await insertWorkspaceAuditEvent(
      {
        workspaceId: data.workspaceId,
        category: 'membership',
        eventType,
        operation: 'write',
        actorUserId: data.actorUserId,
        objectType: 'member',
        objectId: data.targetUserId,
        summary,
        metadata: {
          previousRole: data.previousRole || null,
          nextRole: data.nextRole || null
        }
      },
      client
    );
  }
export async function addWorkspaceMember(
    workspaceId: string,
    input: { userId: string; email: string; role: Role },
    actorUserId: string
  ): Promise<AddWorkspaceMemberResult> {
    return withTransaction(async (client) => {
      const workspaceResult = await client.query(
        `SELECT 1, pg_advisory_xact_lock(hashtext($2), hashtext(LOWER($3)))
         FROM workspaces
         WHERE id = $1
         LIMIT 1`,
        [workspaceId, workspaceId, input.email]
      );
      if (!workspaceResult.rowCount) {
        return { status: 'workspace_not_found' };
      }

      const userResult = await client.query<{ id: string; email: string; display_name: string; source: WorkspaceMembership['source'] }>(
        `SELECT
           u.id,
           u.email,
           u.display_name,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM user_federated_identities fi
               WHERE fi.user_id = u.id AND fi.last_login_at IS NOT NULL
             ) THEN 'oidc'
             ELSE 'internal'
           END AS source
         FROM users u
         WHERE u.id = $1 AND LOWER(u.email) = LOWER($2)
           AND (
             EXISTS (
               SELECT 1 FROM user_password_credentials pc
               WHERE pc.user_id = u.id
                 AND (u.email_verification_required = false OR u.email_verified_at IS NOT NULL)
             )
             OR EXISTS (
               SELECT 1 FROM user_federated_identities fi
               WHERE fi.user_id = u.id AND fi.last_login_at IS NOT NULL
             )
           )
         LIMIT 1`,
        [input.userId, input.email]
      );
      if (!userResult.rowCount) {
        return { status: 'user_not_found' };
      }
      const user = userResult.rows[0];

      const existingMembership = await client.query(
        `SELECT 1
         FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         LIMIT 1`,
        [workspaceId, input.userId]
      );
      if (existingMembership.rowCount) {
        return { status: 'already_exists' };
      }

      const pendingInvitation = await client.query(
        `SELECT 1
         FROM workspace_invitations
         WHERE workspace_id = $1
           AND LOWER(email) = LOWER($2)
           AND status = 'pending'
           AND expires_at > NOW()
         LIMIT 1
         FOR UPDATE`,
        [workspaceId, user.email]
      );
      if (pendingInvitation.rowCount) {
        return { status: 'invitation_pending' };
      }

      await assertWorkspaceMembershipQuota(client, input.userId);
      await assertWorkspaceMemberQuota(client, workspaceId);

      const membershipResult = await client.query<WorkspaceMembershipRow>(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (workspace_id, user_id) DO NOTHING
         RETURNING
           workspace_id,
           user_id,
           $5::text AS email,
           $6::text AS display_name,
           role,
           source,
           created_at,
           updated_at`,
        [workspaceId, input.userId, input.role, user.source, user.email, user.display_name]
      );
      if (!membershipResult.rowCount) {
        return { status: 'already_exists' };
      }

      await recordWorkspaceMembershipAudit(client, {
        workspaceId,
        targetUserId: input.userId,
        actorUserId,
        action: 'member_added',
        nextRole: input.role
      });

      return {
        status: 'created',
        member: mapWorkspaceMembership(membershipResult.rows[0])
      };
    });
  }

export async function updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: Role,
    actorUserId: string
  ): Promise<UpdateWorkspaceMemberResult> {
    return withTransaction(async (client) => {
      const currentResult = await client.query<{ role: Role }>(
        `SELECT role
         FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         FOR UPDATE`,
        [workspaceId, userId]
      );
      if (!currentResult.rowCount) {
        return { status: 'not_found' };
      }
      const previousRole = normalizeRole(currentResult.rows[0].role) || currentResult.rows[0].role;
      if (previousRole === 'owner' && role !== 'owner') {
        const ownersResult = await client.query(
          `SELECT user_id
           FROM workspace_memberships
           WHERE workspace_id = $1 AND role = 'owner'
           FOR UPDATE`,
          [workspaceId]
        );
        if ((ownersResult.rowCount || 0) <= 1) {
          return { status: 'last_owner' };
        }
      }

      const updatedResult = await client.query<WorkspaceMembershipRow>(
        `UPDATE workspace_memberships m
         SET role = $3, updated_at = NOW()
         FROM users u
         WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.id = m.user_id
         RETURNING m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at`,
        [workspaceId, userId, role]
      );

      await recordWorkspaceMembershipAudit(client, {
        workspaceId,
        targetUserId: userId,
        actorUserId,
        action: 'member_role_updated',
        previousRole,
        nextRole: role
      });

      return {
        status: 'updated',
        member: mapWorkspaceMembership(updatedResult.rows[0])
      };
    });
  }
export async function deleteWorkspaceMember(
    workspaceId: string,
    userId: string,
    actorUserId: string
  ): Promise<DeleteWorkspaceMemberResult> {
    return withTransaction(async (client) => {
      const currentResult = await client.query<WorkspaceMembershipRow>(
        `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
         FROM workspace_memberships m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.user_id = $2
         FOR UPDATE`,
        [workspaceId, userId]
      );
      if (!currentResult.rowCount) {
        return { status: 'not_found' };
      }
      const member = mapWorkspaceMembership(currentResult.rows[0]);
      if (member.role === 'owner') {
        const ownersResult = await client.query(
          `SELECT user_id
           FROM workspace_memberships
           WHERE workspace_id = $1 AND role = 'owner'
           FOR UPDATE`,
          [workspaceId]
        );
        if ((ownersResult.rowCount || 0) <= 1) {
          return { status: 'last_owner' };
        }
      }

      await client.query('DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        userId
      ]);

      await recordWorkspaceMembershipAudit(client, {
        workspaceId,
        targetUserId: userId,
        actorUserId,
        action: 'member_removed',
        previousRole: member.role
      });

      return { status: 'deleted', member };
    });
  }

export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const workspaceResult = await client.query('SELECT 1 FROM workspaces WHERE id = $1 LIMIT 1', [workspaceId]);
    if (!workspaceResult.rowCount) {
      return false;
    }

    const targetsResult = await client.query<{ id: string }>(
      'SELECT id FROM targets WHERE workspace_id = $1',
      [workspaceId]
    );
    const targetIds = targetsResult.rows.map((row) => row.id);
    if (targetIds.length > 0) {
      await client.query('DELETE FROM webhook_subscriptions WHERE target_id = ANY($1::text[])', [targetIds]);
      await client.query('DELETE FROM sessions WHERE target_id = ANY($1::text[])', [targetIds]);
      await client.query('DELETE FROM runs WHERE target_id = ANY($1::text[])', [targetIds]);
      await client.query('DELETE FROM run_tool_approvals WHERE target_id = ANY($1::text[])', [targetIds]);
      await client.query('DELETE FROM targets WHERE id = ANY($1::text[])', [targetIds]);
    }

    await client.query('DELETE FROM sessions WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM runs WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM webhook_history WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_invitations WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_audit_events WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_membership_audit WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_agent_registrations WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_inventory_items WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_findings WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_snapshot_summaries WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_snapshots WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM target_metric_history WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_ai_settings WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM webhook_subscriptions WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    return true;
  });
}
