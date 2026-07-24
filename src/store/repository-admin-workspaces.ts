import { config } from '../config.js';
import { db } from '../infra/db.js';
import { WorkspaceSummary } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { mapWorkspaceSummary, WorkspaceRow, toIso } from './repository-mappers.js';
import { WorkspaceQuotaOverrides, resolveWorkspacePlan } from './repository-quotas.js';

interface CountRow { count: number | string; }
export type WorkspaceLifecycleStatus = 'active' | 'suspended';
type AdminWorkspaceRow = WorkspaceRow & {
  lifecycle_status?: WorkspaceLifecycleStatus;
  suspended_at?: Date | string | null;
};

export interface AdminWorkspaceSummary extends WorkspaceSummary {
  virtualMachineCount: number;
  lifecycleStatus: WorkspaceLifecycleStatus;
  suspendedAt?: string;
}

export interface AdminWorkspaceDetail extends AdminWorkspaceSummary {
  quotaOverrides: WorkspaceQuotaOverrides;
  recentRunSummary: Record<string, number>;
  latestWorkspaceAuditAt?: string;
}

function mapAdminWorkspaceSummary(row: AdminWorkspaceRow): AdminWorkspaceSummary {
  return {
    ...mapWorkspaceSummary(row),
    virtualMachineCount: Number(row.virtual_machine_count ?? 0),
    lifecycleStatus: row.lifecycle_status === 'suspended' ? 'suspended' : 'active',
    ...(row.suspended_at ? { suspendedAt: toIso(row.suspended_at) } : {})
  };
}

const adminWorkspaceColumns = `w.*,
  'owner'::text AS current_user_role,
  COALESCE(kubernetes_cluster_counts.cluster_count, 0)::int AS cluster_count,
  COALESCE(virtual_machine_counts.virtual_machine_count, 0)::int AS virtual_machine_count,
  COALESCE(member_counts.member_count, 0)::int AS member_count,
  qo.members AS quota_override_members,
  qo.kubernetes_clusters AS quota_override_kubernetes_clusters,
  qo.virtual_machines AS quota_override_virtual_machines`;

const adminWorkspaceJoins = `
  LEFT JOIN workspace_quota_overrides qo ON qo.workspace_id = w.id
  LEFT JOIN (
    SELECT workspace_id, COUNT(*) AS cluster_count
    FROM targets
    WHERE target_type = 'kubernetes'
    GROUP BY workspace_id
  ) kubernetes_cluster_counts ON kubernetes_cluster_counts.workspace_id = w.id
  LEFT JOIN (
    SELECT workspace_id, COUNT(*) AS virtual_machine_count
    FROM targets
    WHERE target_type = 'virtual_machine'
    GROUP BY workspace_id
  ) virtual_machine_counts ON virtual_machine_counts.workspace_id = w.id
  LEFT JOIN (
    SELECT workspace_id, COUNT(*) AS member_count
    FROM workspace_memberships
    GROUP BY workspace_id
  ) member_counts ON member_counts.workspace_id = w.id`;

function quotaOverrides(row: Record<string, unknown>): WorkspaceQuotaOverrides {
  return {
    members: row.quota_override_members === null || row.quota_override_members === undefined ? null : Number(row.quota_override_members),
    kubernetesClusters: row.quota_override_kubernetes_clusters === null || row.quota_override_kubernetes_clusters === undefined ? null : Number(row.quota_override_kubernetes_clusters),
    virtualMachines: row.quota_override_virtual_machines === null || row.quota_override_virtual_machines === undefined ? null : Number(row.quota_override_virtual_machines)
  };
}

function planQuotaCase(field: 'members' | 'kubernetesClusters' | 'virtualMachines'): string {
  return `(CASE w.plan_key ${config.WORKSPACE_PLANS.plans.map((plan) => `WHEN '${plan.key}' THEN ${plan.quotas[field]}`).join(' ')} ELSE 2147483647 END)`;
}

export async function listAdminWorkspaces(options: {
  limit?: number;
  cursor?: { createdAt: string; workspaceId: string } | null;
  q?: string;
  planKey?: string;
  createdBy?: string;
  createdAfter?: string;
  createdBefore?: string;
  overLimit?: boolean;
  signature?: string;
} = {}): Promise<PagedResult<AdminWorkspaceSummary>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number | boolean> = [limit + 1];
  const clauses: string[] = [];
  const add = (sql: string, value: string | boolean): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (options.q) add('LOWER(w.name) LIKE ?', `%${options.q.toLowerCase()}%`);
  if (options.planKey) add('w.plan_key = ?', options.planKey);
  if (options.createdBy) add('w.created_by = ?', options.createdBy);
  if (options.createdAfter) add('w.created_at >= ?::timestamptz', options.createdAfter);
  if (options.createdBefore) add('w.created_at <= ?::timestamptz', options.createdBefore);
  if (options.overLimit !== undefined) {
    const comparison = options.overLimit ? '>' : '<=';
    const joiner = options.overLimit ? 'OR' : 'AND';
    clauses.push(`(
      COALESCE(member_counts.member_count, 0) ${comparison} COALESCE(qo.members, ${planQuotaCase('members')})
      ${joiner} COALESCE(kubernetes_cluster_counts.cluster_count, 0) ${comparison} COALESCE(qo.kubernetes_clusters, ${planQuotaCase('kubernetesClusters')})
      ${joiner} COALESCE(virtual_machine_counts.virtual_machine_count, 0) ${comparison} COALESCE(qo.virtual_machines, ${planQuotaCase('virtualMachines')})
    )`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.workspaceId);
    clauses.push(`(w.created_at, w.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT ${adminWorkspaceColumns}
     FROM workspaces w
     ${adminWorkspaceJoins}
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT $1`,
    params
  );
  const items = result.rows.map((row) => mapAdminWorkspaceSummary(row as AdminWorkspaceRow));
  return pageWithCursor(items, limit, (workspace) =>
    encodeCursor({ signature: options.signature || '', createdAt: workspace.createdAt, workspaceId: workspace.id })
  );
}

export async function getAdminWorkspace(workspaceId: string): Promise<AdminWorkspaceDetail | null> {
  const result = await db.query(
    `SELECT ${adminWorkspaceColumns},
       latest_audit.occurred_at AS latest_workspace_audit_at
     FROM workspaces w
     ${adminWorkspaceJoins}
     LEFT JOIN LATERAL (
       SELECT occurred_at
       FROM workspace_audit_events
       WHERE workspace_id = w.id
       ORDER BY occurred_at DESC
       LIMIT 1
     ) latest_audit ON true
     WHERE w.id = $1
     LIMIT 1`,
    [workspaceId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const summary = mapAdminWorkspaceSummary(row as AdminWorkspaceRow);
  const runSummaryResult = await db.query<{ status: string; count: number | string }>(
    `SELECT status, COUNT(*)::int AS count
     FROM runs
     WHERE workspace_id = $1
     GROUP BY status`,
    [workspaceId]
  );
  return {
    ...summary,
    quotaOverrides: quotaOverrides(row),
    recentRunSummary: Object.fromEntries(runSummaryResult.rows.map((entry) => [entry.status, Number(entry.count)])),
    ...(row.latest_workspace_audit_at ? { latestWorkspaceAuditAt: new Date(row.latest_workspace_audit_at).toISOString() } : {})
  };
}

export async function updateWorkspacePlan(workspaceId: string, planKey: string): Promise<WorkspaceSummary | null> {
  resolveWorkspacePlan(planKey);
  const result = await db.query(
    `UPDATE workspaces
     SET plan_key = $2
     WHERE id = $1
     RETURNING *`,
    [workspaceId, planKey]
  );
  if (!result.rowCount) return null;
  return (await getAdminWorkspace(workspaceId)) || null;
}

export async function transitionWorkspaceLifecycle(
  workspaceId: string,
  expected: WorkspaceLifecycleStatus,
  next: WorkspaceLifecycleStatus
): Promise<
  | { status: 'updated'; workspace: AdminWorkspaceDetail }
  | { status: 'not_found' }
  | { status: 'state_conflict' }
> {
  const result = await db.query(
    `UPDATE workspaces
     SET lifecycle_status = $3,
         suspended_at = CASE WHEN $3 = 'suspended' THEN NOW() ELSE NULL END
     WHERE id = $1 AND lifecycle_status = $2
     RETURNING id`,
    [workspaceId, expected, next]
  );
  if (!result.rowCount) {
    const exists = await db.query('SELECT 1 FROM workspaces WHERE id = $1', [workspaceId]);
    return { status: exists.rowCount ? 'state_conflict' : 'not_found' };
  }
  const workspace = await getAdminWorkspace(workspaceId);
  if (!workspace) return { status: 'not_found' };
  return { status: 'updated', workspace };
}

export async function countWorkspaceUsage(workspaceId: string): Promise<{
  members: number;
  kubernetesClusters: number;
  virtualMachines: number;
}> {
  const [members, kubernetesClusters, virtualMachines] = await Promise.all([
    db.query<CountRow>('SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]),
    db.query<CountRow>("SELECT COUNT(*)::int AS count FROM targets WHERE workspace_id = $1 AND target_type = 'kubernetes'", [workspaceId]),
    db.query<CountRow>("SELECT COUNT(*)::int AS count FROM targets WHERE workspace_id = $1 AND target_type = 'virtual_machine'", [workspaceId])
  ]);
  return {
    members: Number(members.rows[0]?.count || 0),
    kubernetesClusters: Number(kubernetesClusters.rows[0]?.count || 0),
    virtualMachines: Number(virtualMachines.rows[0]?.count || 0)
  };
}
