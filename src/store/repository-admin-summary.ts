import { db } from '../infra/db.js';

export interface AdminWorkspaceOverview {
  workspaceCount: number;
  suspendedWorkspaceCount: number;
  kubernetesCount: number;
  virtualMachineCount: number;
  environmentLeaders: Array<{ id: string; name: string; clusterCount: number; virtualMachineCount: number }>;
}

export async function getAdminWorkspaceOverview(): Promise<AdminWorkspaceOverview> {
  // One statement gives counts and leaders from the same snapshot. Only three
  // governance rows leave PostgreSQL, regardless of platform catalog size.
  const result = await db.query<AdminWorkspaceOverview>(`
    WITH footprints AS (
      SELECT w.id, w.name, w.lifecycle_status,
        COUNT(t.workspace_id) FILTER (WHERE t.target_type = 'kubernetes')::int AS clusters,
        COUNT(t.workspace_id) FILTER (WHERE t.target_type = 'virtual_machine')::int AS vms
      FROM workspaces w LEFT JOIN targets t ON t.workspace_id = w.id
      GROUP BY w.id, w.name, w.lifecycle_status
    ), leaders AS (
      SELECT id, name, clusters AS "clusterCount", vms AS "virtualMachineCount"
      FROM footprints
      ORDER BY clusters + vms DESC, name ASC, id ASC LIMIT 3
    )
    SELECT COUNT(*)::int AS "workspaceCount",
      COUNT(*) FILTER (WHERE lifecycle_status = 'suspended')::int AS "suspendedWorkspaceCount",
      COALESCE(SUM(clusters), 0)::int AS "kubernetesCount",
      COALESCE(SUM(vms), 0)::int AS "virtualMachineCount",
      (SELECT COALESCE(json_agg(leaders), '[]'::json) FROM leaders) AS "environmentLeaders"
    FROM footprints
  `);
  return result.rows[0];
}

export async function getAdminUserOverview(): Promise<{ userCount: number; verifiedUserCount: number }> {
  const result = await db.query<{ userCount: number; verifiedUserCount: number }>(`
    SELECT COUNT(*)::int AS "userCount",
      COUNT(email_verified_at)::int AS "verifiedUserCount" FROM users
  `);
  return result.rows[0];
}
