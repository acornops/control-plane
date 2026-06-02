import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { Role, WorkspaceMembership, WorkspaceMembershipAuditAction } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import {
  AddWorkspaceMemberResult,
  DeleteWorkspaceMemberResult,
  UpdateWorkspaceMemberResult,
  UserRow,
  WorkspaceMembershipRow,
  displayNameFromEmail,
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
        targetType: 'member',
        targetId: data.targetUserId,
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
    input: { email: string; displayName?: string; role: Role },
    actorUserId: string
  ): Promise<AddWorkspaceMemberResult> {
    const email = input.email.trim().toLowerCase();
    const requestedDisplayName = input.displayName?.trim();
    const displayName = requestedDisplayName || displayNameFromEmail(email);
    return withTransaction(async (client) => {
      const workspaceResult = await client.query('SELECT 1 FROM workspaces WHERE id = $1 LIMIT 1', [workspaceId]);
      if (!workspaceResult.rowCount) {
        return { status: 'workspace_not_found' };
      }

      const userId = randomUUID();
      const userResult = await client.query<UserRow>(
        `INSERT INTO users (id, email, display_name, email_verified_at, email_verification_required, created_at)
         VALUES ($1, $2, $3, NOW(), false, NOW())
         ON CONFLICT (email) DO UPDATE
         SET display_name = CASE
           WHEN $4::boolean THEN EXCLUDED.display_name
           ELSE users.display_name
         END,
         email_verified_at = COALESCE(users.email_verified_at, NOW()),
         email_verification_required = false
         RETURNING *`,
        [userId, email, displayName, Boolean(requestedDisplayName)]
      );
      const user = userResult.rows[0];

      const existingMembership = await client.query(
        `SELECT 1
         FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         LIMIT 1`,
        [workspaceId, user.id]
      );
      if (existingMembership.rowCount) {
        return { status: 'already_exists' };
      }

      await assertWorkspaceMembershipQuota(client, user.id);
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
        [workspaceId, user.id, input.role, 'internal', user.email, user.display_name]
      );
      if (!membershipResult.rowCount) {
        return { status: 'already_exists' };
      }

      await recordWorkspaceMembershipAudit(client, {
        workspaceId,
        targetUserId: user.id,
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
    await client.query('DELETE FROM target_snapshot_history WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM webhook_subscriptions WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    return true;
  });
}
