import { PoolClient } from 'pg';
import { config, WorkspacePlanDefinition } from '../config.js';
import { db } from '../infra/db.js';
import {
  KUBERNETES_TARGET_TYPE,
  QuotaKey,
  QuotaUsage,
  TargetType,
  UserQuota,
  WorkspacePlanKey,
  WorkspaceQuota
} from '../types/domain.js';

interface CountRow {
  count: number | string;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly quotaKey: QuotaKey,
    readonly used: number,
    readonly limit: number,
    message: string
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

function usage(used: number, limit: number): QuotaUsage {
  return { used, limit };
}

export interface WorkspaceQuotaOverrides {
  members?: number | null;
  kubernetesClusters?: number | null;
  virtualMachines?: number | null;
}

interface WorkspaceQuotaRow {
  plan_key: string | null;
  members: number | null;
  kubernetes_clusters: number | null;
  virtual_machines: number | null;
}

interface EffectiveWorkspaceLimits {
  plan: WorkspacePlanDefinition;
  quotas: {
    members: number;
    kubernetesClusters: number;
    virtualMachines: number;
  };
}

export function defaultWorkspacePlanKey(): WorkspacePlanKey {
  return config.WORKSPACE_PLANS.defaultPlanKey;
}

export function workspacePlanCatalog(): Record<WorkspacePlanKey, WorkspacePlanDefinition | undefined> {
  return Object.fromEntries(config.WORKSPACE_PLANS.plans.map((plan) => [plan.key, plan]));
}

export function resolveWorkspacePlan(planKey: string | null | undefined): WorkspacePlanDefinition {
  const key = planKey ?? defaultWorkspacePlanKey();
  const plan = workspacePlanCatalog()[key];
  if (!plan) {
    throw new Error(`Unknown workspace plan: ${key}`);
  }
  return plan;
}

export function workspaceMembershipLimit(): number {
  return config.QUOTA_MAX_WORKSPACE_MEMBERSHIPS;
}

export function workspaceMemberLimit(): number {
  return config.QUOTA_MAX_WORKSPACE_MEMBERS_PER_WORKSPACE;
}

export function kubernetesClusterLimit(): number {
  return config.QUOTA_MAX_KUBERNETES_CLUSTERS_PER_WORKSPACE;
}

export function virtualMachineLimit(): number {
  return config.QUOTA_MAX_VIRTUAL_MACHINES_PER_WORKSPACE;
}

export function buildWorkspaceQuota(input: {
  planKey?: string | null;
  quotaOverrides?: WorkspaceQuotaOverrides | null;
  members: number;
  kubernetesClusters: number;
  virtualMachines: number;
  canReadWorkspaceData: boolean;
}): WorkspaceQuota {
  const limits = effectiveWorkspaceLimits(input.planKey, input.quotaOverrides);
  return {
    members: usage(input.members, limits.quotas.members),
    kubernetesClusters: usage(input.canReadWorkspaceData ? input.kubernetesClusters : 0, limits.quotas.kubernetesClusters),
    virtualMachines: usage(input.canReadWorkspaceData ? input.virtualMachines : 0, limits.quotas.virtualMachines)
  };
}

export function effectiveWorkspaceLimits(
  planKey: string | null | undefined,
  overrides?: WorkspaceQuotaOverrides | null
): EffectiveWorkspaceLimits {
  const plan = resolveWorkspacePlan(planKey);
  return {
    plan,
    quotas: {
      members: overrides?.members ?? plan.quotas.members,
      kubernetesClusters: overrides?.kubernetesClusters ?? plan.quotas.kubernetesClusters,
      virtualMachines: overrides?.virtualMachines ?? plan.quotas.virtualMachines
    }
  };
}

function quotaOverridesFromRow(row: WorkspaceQuotaRow | undefined): WorkspaceQuotaOverrides {
  return {
    members: row?.members ?? null,
    kubernetesClusters: row?.kubernetes_clusters ?? null,
    virtualMachines: row?.virtual_machines ?? null
  };
}

async function getWorkspaceQuotaOverrides(client: PoolClient, workspaceId: string): Promise<WorkspaceQuotaOverrides> {
  const result = await client.query<WorkspaceQuotaRow>(
    `SELECT members, kubernetes_clusters, virtual_machines
     FROM workspace_quota_overrides
     WHERE workspace_id = $1`,
    [workspaceId]
  );
  return quotaOverridesFromRow(result.rows[0]);
}

export async function getUserQuotaForUser(userId: string): Promise<UserQuota> {
  const result = await db.query<CountRow>(
    'SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE user_id = $1',
    [userId]
  );
  return {
    workspaceMemberships: usage(Number(result.rows[0]?.count ?? 0), workspaceMembershipLimit())
  };
}

export async function assertWorkspaceMembershipQuota(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const result = await client.query<CountRow>(
    'SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE user_id = $1',
    [userId]
  );
  const used = Number(result.rows[0]?.count ?? 0);
  const limit = workspaceMembershipLimit();
  if (used >= limit) {
    throw new QuotaExceededError(
      'workspaceMemberships',
      used,
      limit,
      `User has reached the workspace membership limit of ${limit}`
    );
  }
}

export async function assertWorkspaceMemberQuota(client: PoolClient, workspaceId: string): Promise<void> {
  const workspaceResult = await client.query<{ plan_key: string | null }>(
    'SELECT plan_key FROM workspaces WHERE id = $1 FOR UPDATE',
    [workspaceId]
  );
  const limits = effectiveWorkspaceLimits(workspaceResult.rows[0]?.plan_key, await getWorkspaceQuotaOverrides(client, workspaceId));
  const result = await client.query<CountRow>(
    'SELECT COUNT(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1',
    [workspaceId]
  );
  const used = Number(result.rows[0]?.count ?? 0);
  const limit = limits.quotas.members;
  if (used >= limit) {
    throw new QuotaExceededError(
      'workspaceMembers',
      used,
      limit,
      `Workspace has reached the member limit of ${limit}`
    );
  }
}

export async function assertWorkspaceTargetQuota(
  client: PoolClient,
  workspaceId: string,
  targetType: TargetType
): Promise<void> {
  const workspaceResult = await client.query<{ plan_key: string | null }>(
    'SELECT plan_key FROM workspaces WHERE id = $1 FOR UPDATE',
    [workspaceId]
  );
  const limits = effectiveWorkspaceLimits(workspaceResult.rows[0]?.plan_key, await getWorkspaceQuotaOverrides(client, workspaceId));
  const result = await client.query<CountRow>(
    'SELECT COUNT(*)::int AS count FROM targets WHERE workspace_id = $1 AND target_type = $2',
    [workspaceId, targetType]
  );
  const used = Number(result.rows[0]?.count ?? 0);
  const limit = targetType === KUBERNETES_TARGET_TYPE ? limits.quotas.kubernetesClusters : limits.quotas.virtualMachines;
  if (used < limit) return;

  const quotaKey: QuotaKey = targetType === KUBERNETES_TARGET_TYPE ? 'kubernetesClusters' : 'virtualMachines';
  const label = targetType === KUBERNETES_TARGET_TYPE ? 'Kubernetes cluster' : 'virtual machine';
  throw new QuotaExceededError(
    quotaKey,
    used,
    limit,
    `Workspace has reached the ${label.toLowerCase()} limit of ${limit}`
  );
}
