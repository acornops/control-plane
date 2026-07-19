import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { AuthMethod, Run, TargetSummary, TARGET_TYPES, TargetType, User, WorkspaceMembership, WorkspaceSummary } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import {
  mapRun,
  mapTarget,
  mapUser,
  mapWorkspaceMembership,
  RunRow,
  TargetRow,
  UserRow,
  WorkspaceMembershipRow
} from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { AdminAuditEventInput, insertAdminAuditEvent } from './repository-admin-audit.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { WorkspaceAuditEventInput } from '../types/domain.js';
import { incrementAdminAuditWriteFailures } from '../metrics.js';
import { WorkspaceQuotaOverrides, assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from './repository-quotas.js';
import { getAdminWorkspace } from './repository-admin-workspaces.js';
export {
  countWorkspaceUsage,
  getAdminWorkspace,
  listAdminWorkspaces,
  transitionWorkspaceLifecycle,
  updateWorkspacePlan
} from './repository-admin-workspaces.js';
export type {
  AdminWorkspaceDetail,
  AdminWorkspaceSummary,
  WorkspaceLifecycleStatus
} from './repository-admin-workspaces.js';

export interface AdminWorkspaceMembershipAudit {
  admin: AdminAuditEventInput;
  workspace: WorkspaceAuditEventInput[];
}

async function insertMembershipAudit(client: Parameters<Parameters<typeof withTransaction>[0]>[0], audit?: AdminWorkspaceMembershipAudit): Promise<void> {
  if (!audit) return;
  try {
    await insertAdminAuditEvent(audit.admin, client);
    for (const event of audit.workspace) {
      // Admin membership changes are governance records and must not be disabled by
      // the optional workspace read-audit logging mode.
      await insertWorkspaceAuditEvent(event, client, 'read_write');
    }
  } catch (err) {
    incrementAdminAuditWriteFailures();
    throw err;
  }
}

export async function setWorkspaceQuotaOverrides(
  workspaceId: string,
  quotas: WorkspaceQuotaOverrides | null
): Promise<WorkspaceSummary | null> {
  if (!quotas) {
    const result = await db.query('DELETE FROM workspace_quota_overrides WHERE workspace_id = $1', [workspaceId]);
    if ((result.rowCount ?? 0) === 0) {
      const exists = await db.query('SELECT 1 FROM workspaces WHERE id = $1', [workspaceId]);
      if (!exists.rowCount) return null;
    }
    return (await getAdminWorkspace(workspaceId)) || null;
  }
  const result = await db.query(
    `INSERT INTO workspace_quota_overrides (workspace_id, members, kubernetes_clusters, virtual_machines, updated_at)
     SELECT id, $2, $3, $4, NOW()
     FROM workspaces
     WHERE id = $1
     ON CONFLICT (workspace_id) DO UPDATE
     SET members = EXCLUDED.members,
         kubernetes_clusters = EXCLUDED.kubernetes_clusters,
         virtual_machines = EXCLUDED.virtual_machines,
         updated_at = NOW()
     RETURNING workspace_id`,
    [workspaceId, quotas.members ?? null, quotas.kubernetesClusters ?? null, quotas.virtualMachines ?? null]
  );
  if (!result.rowCount) return null;
  return (await getAdminWorkspace(workspaceId)) || null;
}

export async function listAdminUsers(options: {
  limit?: number;
  cursor?: { createdAt: string; userId: string } | null;
  q?: string;
  email?: string;
  authMethod?: 'password' | 'oidc';
  emailVerified?: boolean;
  signature?: string;
} = {}): Promise<PagedResult<User & { authMethods: string[]; emailVerified: boolean; workspaceMembershipCount: number }>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number | boolean> = [limit + 1];
  const clauses: string[] = [];
  const add = (sql: string, value: string | boolean): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (options.q) {
    params.push(`%${options.q.toLowerCase()}%`);
    clauses.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(u.display_name) LIKE $${params.length})`);
  }
  if (options.email) add('u.email = ?', options.email.toLowerCase());
  if (options.emailVerified !== undefined) add('(u.email_verified_at IS NOT NULL) = ?', options.emailVerified);
  if (options.authMethod === 'password') clauses.push('pc.user_id IS NOT NULL');
  if (options.authMethod === 'oidc') clauses.push('fi.user_id IS NOT NULL');
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.userId);
    clauses.push(`(u.created_at, u.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT u.*,
       pc.user_id IS NOT NULL AS has_password,
       fi.user_id IS NOT NULL AS has_oidc,
       COALESCE(member_counts.member_count, 0)::int AS member_count
     FROM users u
     LEFT JOIN (SELECT DISTINCT user_id FROM user_password_credentials) pc ON pc.user_id = u.id
     LEFT JOIN (SELECT DISTINCT user_id FROM user_federated_identities) fi ON fi.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS member_count
       FROM workspace_memberships
       GROUP BY user_id
     ) member_counts ON member_counts.user_id = u.id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY u.created_at ASC, u.id ASC
     LIMIT $1`,
    params
  );
  const items = result.rows.map((row) => ({
    ...mapUser(row as UserRow),
    emailVerified: Boolean(row.email_verified_at),
    authMethods: [row.has_password ? 'password' : null, row.has_oidc ? 'oidc' : null].filter((method): method is string => Boolean(method)),
    workspaceMembershipCount: Number(row.member_count || 0)
  }));
  return pageWithCursor(items, limit, (user) =>
    encodeCursor({ signature: options.signature || '', createdAt: user.createdAt, userId: user.id })
  );
}

export async function getAdminUser(userId: string): Promise<{
  user: User & { emailVerified: boolean };
  authMethods: Pick<AuthMethod, 'type'>[];
  activeSessionCount: number | null;
  memberships: WorkspaceMembership[];
} | null> {
  const userResult = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!userResult.rowCount) return null;
  const [passwordResult, federatedResult, membershipsResult] = await Promise.all([
    db.query('SELECT 1 FROM user_password_credentials WHERE user_id = $1 LIMIT 1', [userId]),
    db.query<{ provider: string }>('SELECT provider FROM user_federated_identities WHERE user_id = $1 ORDER BY provider ASC', [userId]),
    db.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1
       ORDER BY m.created_at ASC`,
      [userId]
    )
  ]);
  return {
    user: { ...mapUser(userResult.rows[0]), emailVerified: Boolean(userResult.rows[0].email_verified_at) },
    authMethods: [
      ...(passwordResult.rowCount ? [{ type: 'password' as const }] : []),
      ...federatedResult.rows.map(() => ({ type: 'oidc' as const }))
    ],
    activeSessionCount: null,
    memberships: membershipsResult.rows.map(mapWorkspaceMembership)
  };
}

export async function listAdminWorkspaceMembers(options: {
  workspaceId: string;
  limit?: number;
  cursor?: { createdAt: string; userId: string } | null;
  signature?: string;
}): Promise<PagedResult<WorkspaceMembership>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [options.workspaceId, limit + 1];
  const clauses = ['m.workspace_id = $1'];
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.userId);
    clauses.push(`(m.created_at, m.user_id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query<WorkspaceMembershipRow>(
    `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
     FROM workspace_memberships m
     INNER JOIN users u ON u.id = m.user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.created_at ASC, m.user_id ASC
     LIMIT $2`,
    params
  );
  const items = result.rows.map(mapWorkspaceMembership);
  return pageWithCursor(items, limit, (member) =>
    encodeCursor({ signature: options.signature || '', createdAt: member.createdAt, userId: member.userId })
  );
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await db.query<UserRow>('SELECT * FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rowCount ? mapUser(result.rows[0]) : null;
}

export async function createVerifiedInternalUser(email: string, displayName: string): Promise<User> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (id, email, display_name, email_verified_at, email_verification_required, created_at)
     VALUES ($1, $2, $3, NOW(), false, NOW())
     RETURNING *`,
    [randomUUID(), email.toLowerCase(), displayName]
  );
  return mapUser(result.rows[0]);
}

export async function addExistingWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: string,
  audit?: AdminWorkspaceMembershipAudit
): Promise<{ status: 'created' | 'workspace_not_found' | 'user_not_found' | 'already_exists'; member?: WorkspaceMembership }> {
  return withTransaction(async (client) => {
    const workspace = await client.query('SELECT 1 FROM workspaces WHERE id = $1 LIMIT 1', [workspaceId]);
    if (!workspace.rowCount) return { status: 'workspace_not_found' };
    const user = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!user.rowCount) return { status: 'user_not_found' };
    await assertWorkspaceMembershipQuota(client, userId);
    await assertWorkspaceMemberQuota(client, workspaceId);
    const inserted = await client.query<WorkspaceMembershipRow>(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, source, created_at, updated_at)
       VALUES ($1, $2, $3, 'internal', NOW(), NOW())
       ON CONFLICT (workspace_id, user_id) DO NOTHING
       RETURNING
         workspace_id,
         user_id,
         $4::text AS email,
         $5::text AS display_name,
         role,
         source,
         created_at,
         updated_at`,
      [workspaceId, userId, role, user.rows[0].email, user.rows[0].display_name]
    );
    if (!inserted.rowCount) return { status: 'already_exists' };
    await insertMembershipAudit(client, audit);
    return { status: 'created', member: mapWorkspaceMembership(inserted.rows[0]) };
  });
}

export async function replaceLastOwnerAndDeleteMember(
  workspaceId: string,
  userId: string,
  replacementOwnerUserId: string,
  audit?: AdminWorkspaceMembershipAudit
): Promise<{ status: 'deleted' | 'not_found' | 'replacement_not_found'; member?: WorkspaceMembership }> {
  return withTransaction(async (client) => {
    const replacement = await client.query(
      `SELECT 1 FROM workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
       FOR UPDATE`,
      [workspaceId, replacementOwnerUserId]
    );
    if (!replacement.rowCount) return { status: 'replacement_not_found' };
    await client.query(
      `UPDATE workspace_memberships
       SET role = 'owner', updated_at = NOW()
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, replacementOwnerUserId]
    );
    const deleted = await client.query<WorkspaceMembershipRow>(
      `DELETE FROM workspace_memberships m
       USING users u
       WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.id = m.user_id
       RETURNING m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at`,
      [workspaceId, userId]
    );
    if (!deleted.rowCount) return { status: 'not_found' };
    await insertMembershipAudit(client, audit);
    return { status: 'deleted', member: mapWorkspaceMembership(deleted.rows[0]) };
  });
}

export async function updateExistingWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: string,
  audit?: AdminWorkspaceMembershipAudit
): Promise<{ status: 'updated' | 'not_found' | 'last_owner'; member?: WorkspaceMembership; previousRole?: string }> {
  return withTransaction(async (client) => {
    const current = await client.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2
       FOR UPDATE`,
      [workspaceId, userId]
    );
    if (!current.rowCount) return { status: 'not_found' };
    const previous = mapWorkspaceMembership(current.rows[0]);
    if (previous.role === 'owner' && role !== 'owner') {
      const owners = await client.query(
        `SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`,
        [workspaceId]
      );
      if ((owners.rowCount || 0) <= 1) return { status: 'last_owner' };
    }
    const updated = await client.query<WorkspaceMembershipRow>(
      `UPDATE workspace_memberships m
       SET role = $3, updated_at = NOW()
       FROM users u
       WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.id = m.user_id
       RETURNING m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at`,
      [workspaceId, userId, role]
    );
    if (audit) {
      audit.admin.metadata = { ...(audit.admin.metadata || {}), beforeRole: previous.role };
      if (audit.workspace[0]) {
        audit.workspace[0].metadata = { ...(audit.workspace[0].metadata || {}), beforeRole: previous.role };
      }
    }
    await insertMembershipAudit(client, audit);
    return { status: 'updated', member: mapWorkspaceMembership(updated.rows[0]), previousRole: previous.role };
  });
}

export async function deleteExistingWorkspaceMember(
  workspaceId: string,
  userId: string,
  audit?: AdminWorkspaceMembershipAudit
): Promise<{ status: 'deleted' | 'not_found' | 'last_owner'; member?: WorkspaceMembership }> {
  return withTransaction(async (client) => {
    const current = await client.query<WorkspaceMembershipRow>(
      `SELECT m.workspace_id, m.user_id, u.email, u.display_name, m.role, m.source, m.created_at, m.updated_at
       FROM workspace_memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2
       FOR UPDATE`,
      [workspaceId, userId]
    );
    if (!current.rowCount) return { status: 'not_found' };
    const member = mapWorkspaceMembership(current.rows[0]);
    if (member.role === 'owner') {
      const owners = await client.query(
        `SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`,
        [workspaceId]
      );
      if ((owners.rowCount || 0) <= 1) return { status: 'last_owner' };
    }
    await client.query('DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
    await insertMembershipAudit(client, audit);
    return { status: 'deleted', member };
  });
}

export async function listAdminTargets(options: {
  limit?: number;
  cursor?: { createdAt: string; targetId: string } | null;
  workspaceId?: string;
  targetType?: TargetType;
  status?: string;
  q?: string;
  lastSeenBefore?: string;
  lastSeenAfter?: string;
  signature?: string;
} = {}): Promise<PagedResult<TargetSummary & { workspaceName?: string; lastHeartbeatAt?: string }>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [limit + 1];
  const clauses: string[] = [];
  const add = (sql: string, value: string): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (options.workspaceId) add('t.workspace_id = ?', options.workspaceId);
  if (options.targetType && TARGET_TYPES.includes(options.targetType)) add('t.target_type = ?', options.targetType);
  if (options.status) add('t.status = ?', options.status);
  if (options.q) add('LOWER(t.name) LIKE ?', `%${options.q.toLowerCase()}%`);
  if (options.lastSeenBefore) add('r.last_seen_at <= ?::timestamptz', options.lastSeenBefore);
  if (options.lastSeenAfter) add('r.last_seen_at >= ?::timestamptz', options.lastSeenAfter);
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.targetId);
    clauses.push(`(t.created_at, t.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT t.*, w.name AS workspace_name, r.last_heartbeat_at
     FROM targets t
     INNER JOIN workspaces w ON w.id = t.workspace_id
     LEFT JOIN target_agent_registrations r ON r.target_id = t.id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY t.created_at ASC, t.id ASC
     LIMIT $1`,
    params
  );
  const items = result.rows.map((row) => ({
    ...mapTarget(row as TargetRow),
    workspaceName: row.workspace_name,
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString() } : {})
  }));
  return pageWithCursor(items, limit, (target) =>
    encodeCursor({ signature: options.signature || '', createdAt: target.createdAt, targetId: target.id })
  );
}

export async function getTargetById(targetId: string): Promise<TargetSummary | null> {
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE id = $1`,
    [targetId]
  );
  return result.rowCount ? mapTarget(result.rows[0]) : null;
}

export async function listAdminRuns(options: {
  limit?: number;
  cursor?: { requestedAt: string; runId: string } | null;
  workspaceId?: string;
  targetId?: string;
  targetType?: TargetType;
  sessionId?: string;
  status?: Run['status'];
  requestedBy?: string;
  errorCode?: string;
  active?: boolean;
  olderThanSeconds?: number;
  signature?: string;
} = {}): Promise<PagedResult<Run>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number | boolean> = [limit + 1];
  const clauses: string[] = [];
  const add = (sql: string, value: string | number | boolean): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (options.workspaceId) add('r.workspace_id = ?', options.workspaceId);
  if (options.targetId) add('r.target_id = ?', options.targetId);
  if (options.targetType) add('t.target_type = ?', options.targetType);
  if (options.sessionId) add('r.session_id = ?', options.sessionId);
  if (options.status) add('r.status = ?', options.status);
  if (options.requestedBy) add('s.created_by = ?', options.requestedBy);
  if (options.errorCode) add('r.error_code = ?', options.errorCode);
  if (options.active !== undefined) {
    clauses.push(options.active ? "r.status NOT IN ('completed','failed','cancelled')" : "r.status IN ('completed','failed','cancelled')");
  }
  if (options.olderThanSeconds !== undefined) add("r.requested_at <= NOW() - (?::int * INTERVAL '1 second')", options.olderThanSeconds);
  if (options.cursor) {
    params.push(options.cursor.requestedAt, options.cursor.runId);
    clauses.push(`(r.requested_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT r.*, t.target_type
     FROM runs r
     INNER JOIN targets t ON t.id = r.target_id
     LEFT JOIN sessions s ON s.id = r.session_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY r.requested_at DESC, r.id DESC
     LIMIT $1`,
    params
  );
  const items = result.rows.map((row) => mapRun(row as RunRow));
  return pageWithCursor(items, limit, (run) =>
    encodeCursor({ signature: options.signature || '', requestedAt: run.requestedAt, runId: run.id })
  );
}
