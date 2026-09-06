import { config } from '../config.js';
import { db } from '../infra/db.js';
import { canonicalPolicyHash } from '../store/repository-workspace-policy-read.js';
import { resolveExecutionLimits } from '../types/workspace-policy.js';

export function workspaceCatalogFingerprint(): string {
  return canonicalPolicyHash({ defaultPlanKey: config.WORKSPACE_PLANS.defaultPlanKey,
    plans: config.WORKSPACE_PLANS.plans.map(plan => ({ key: plan.key, quotas: plan.quotas,
      executionLimits: resolveExecutionLimits(plan.executionLimits) })).sort((a, b) => a.key.localeCompare(b.key)) });
}

/** Opening admission requires a prepared catalogue. Quiesced replicas may change mode. */
export async function assertWorkspaceCapacityRollout(): Promise<void> {
  const result = await db.query<{ active: boolean; catalog_hash: string | null; verified_at: Date | null }>('SELECT active,catalog_hash,verified_at FROM workspace_capacity_rollout WHERE singleton');
  const current = result.rows[0];
  if (!current) throw new Error('Workspace capacity rollout state is missing');
  if (!config.WORKSPACE_ADMISSION_ENABLED && !config.WORKSPACE_DISPATCH_ENABLED) return;
  if (current.active !== config.WORKSPACE_CAPACITY_ENABLED) throw new Error('Workspace capacity mode differs from prepared rollout; close admission and dispatch before changing mode');
  if (current.active && !current.verified_at) throw new Error('Workspace capacity peers have not passed rollout verification');
  if (current.active && current.catalog_hash !== workspaceCatalogFingerprint()) throw new Error('Workspace plan catalogue differs from activated capacity catalogue');
}
