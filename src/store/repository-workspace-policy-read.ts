import { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { DEFAULT_ADMIN_SUSPENSION_REASON, EXECUTION_POOLS, ExecutionPool, ExecutionUsage, WorkspacePolicyError } from '../types/workspace-policy.js';
import { effectiveWorkspaceLimits } from './repository-quotas.js';
import { getAdminWorkspace } from './repository-admin-workspaces.js';
import { withTransaction } from './repository-transaction.js';

type Queryable = Pick<PoolClient, 'query'>;
export function canonicalPolicyHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function readExecutionUsage(client: Queryable, workspaceId: string): Promise<ExecutionUsage> {
  const usage = Object.fromEntries(EXECUTION_POOLS.map(pool => [pool, { concurrentRuns: 0, outstandingRuns: 0 }])) as ExecutionUsage;
  const exists = await client.query("SELECT to_regclass('workspace_run_reservations') AS table_name");
  if (!exists.rows[0]?.table_name) return usage;
  const result = await client.query<{ pool: ExecutionPool; concurrent: number; outstanding: number }>(
    `SELECT pool, COUNT(*) FILTER (WHERE executing_until IS NOT NULL)::int AS concurrent, COUNT(*)::int AS outstanding
     FROM workspace_run_reservations WHERE workspace_id = $1 AND settled_at IS NULL GROUP BY pool`, [workspaceId]);
  for (const row of result.rows) if (EXECUTION_POOLS.includes(row.pool)) usage[row.pool] = { concurrentRuns: Number(row.concurrent), outstandingRuns: Number(row.outstanding) };
  return usage;
}
export async function readPolicySnapshot(client: Queryable, workspaceId: string) {
  const workspace = await getAdminWorkspace(workspaceId, client);
  if (!workspace) throw new WorkspacePolicyError('NOT_FOUND', 404, 'Workspace not found');
  const holds = await client.query<{ source: 'admin' | 'external'; public_reason: string | null; created_at: Date }>(
    'SELECT source, public_reason, created_at FROM workspace_suspension_holds WHERE workspace_id = $1 ORDER BY source', [workspaceId]);
  return {
    workspace,
    policy: {
      workspaceId, workspaceName: workspace.name, plan: workspace.plan,
      effectiveLimits: effectiveWorkspaceLimits(workspace.plan.key, workspace.quotaOverrides),
      quotaOverrides: workspace.quotaOverrides, policyVersion: workspace.policyVersion ?? 0,
      lifecycleStatus: workspace.lifecycleStatus, suspendedAt: workspace.suspendedAt ?? null,
      publicReason: workspace.lifecycleStatus === 'suspended' ? holds.rows.find(row => row.source === 'admin')?.public_reason
        ?? (holds.rows.some(row => row.source === 'admin') ? DEFAULT_ADMIN_SUSPENSION_REASON : holds.rows[0]?.public_reason ?? DEFAULT_ADMIN_SUSPENSION_REASON) : null,
      usage: { members: workspace.memberCount, kubernetesClusters: workspace.clusterCount, virtualMachines: workspace.virtualMachineCount, execution: await readExecutionUsage(client, workspaceId) },
      holds: holds.rows.map(row => ({ source: row.source, publicReason: row.public_reason ?? (row.source === 'admin' ? DEFAULT_ADMIN_SUSPENSION_REASON : null), createdAt: new Date(row.created_at).toISOString() }))
    }
  };
}
export async function getWorkspacePolicy(workspaceId: string) {
  return withTransaction(async client => {
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR SHARE', [workspaceId]);
    return (await readPolicySnapshot(client, workspaceId)).policy;
  });
}
export async function preflightWorkspacePlanCatalog(queryable: Queryable = db): Promise<void> {
  const assigned = await queryable.query<{ plan_key: string }>('SELECT DISTINCT plan_key FROM workspaces');
  for (const row of assigned.rows) {
    if (!config.WORKSPACE_PLANS.plans.some(plan => plan.key === row.plan_key)) throw new WorkspacePolicyError('WORKSPACE_PLAN_NOT_CONFIGURED', 400, `Assigned workspace plan is not configured: ${row.plan_key}`);
  }
  for (const plan of config.WORKSPACE_PLANS.plans) {
    const limits = effectiveWorkspaceLimits(plan.key);
    const hash = canonicalPolicyHash({ quotas: limits.quotas, executionLimits: limits.executionLimits });
    await queryable.query('INSERT INTO workspace_plan_definitions (plan_key, limits_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', [plan.key, hash]);
    const previous = await queryable.query('SELECT limits_hash FROM workspace_plan_definitions WHERE plan_key=$1', [plan.key]);
    if (previous.rows[0].limits_hash !== hash) throw new Error(`Workspace plan limits changed for immutable key: ${plan.key}; configure a new plan key`);
  }
}

/** Remove at most one batch; normal lookup expires receipts after 30 days independently. */
export async function cleanupWorkspacePolicyReceipts(batchSize = 1000, queryable: Queryable = db): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error('Receipt cleanup batch size must be between 1 and 10000');
  const result = await queryable.query(`WITH expired AS (
    SELECT ctid FROM workspace_policy_receipts WHERE created_at < NOW()-INTERVAL '30 days'
    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM workspace_policy_receipts receipt USING expired WHERE receipt.ctid=expired.ctid`, [batchSize]);
  return result.rowCount ?? 0;
}
