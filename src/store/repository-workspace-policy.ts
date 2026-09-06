import { policyAuditState, recordPolicyFailure } from './repository-workspace-policy-audit.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { PoolClient } from 'pg';
import { DEFAULT_ADMIN_SUSPENSION_REASON, EXECUTION_POOLS, WorkspacePolicyError } from '../types/workspace-policy.js';
import { AdminAuditEventInput, insertAdminAuditEvent } from './repository-admin-audit.js';
import { effectiveWorkspaceLimits, WorkspaceQuotaOverrides, workspacePlanCatalog } from './repository-quotas.js';
import { canonicalPolicyHash, readPolicySnapshot } from './repository-workspace-policy-read.js';
import { AdminWorkspaceDetail } from './repository-admin-workspaces.js';
import { withTransaction } from './repository-transaction.js';

export type PolicyOperation = 'plan' | 'quotas' | 'suspend' | 'restore';
export interface PolicyMutationBody {
  requestId?: string; expectedPolicyVersion?: number; overLimitBehavior?: 'reject' | 'retain_existing';
  source?: 'admin' | 'external'; publicReason?: string; reason: string; ticketRef?: string;
  workspaceName?: string; planKey?: string; quotas?: WorkspaceQuotaOverrides | null;
}
export interface PolicyMutationInput { workspaceId: string; operation: PolicyOperation; body: PolicyMutationBody; audit: AdminAuditEventInput; }
export interface PolicyMutationResponse {
  before: AdminWorkspaceDetail;
  after: AdminWorkspaceDetail;
  policy: Awaited<ReturnType<typeof readPolicySnapshot>>['policy'];
  changed: boolean;
  usage?: Awaited<ReturnType<typeof readPolicySnapshot>>['policy']['usage'];
  overLimit?: { members: boolean; kubernetesClusters: boolean; virtualMachines: boolean };
}
function fail(code: string, status: number, message: string): never { throw new WorkspacePolicyError(code, status, message); }
function overrides(input?: WorkspaceQuotaOverrides | null): WorkspaceQuotaOverrides {
  return { members: input?.members ?? null, kubernetesClusters: input?.kubernetesClusters ?? null, virtualMachines: input?.virtualMachines ?? null };
}
async function writeHold(client: PoolClient, input: PolicyMutationInput): Promise<void> {
  const source = input.body.source ?? 'admin';
  if (input.operation === 'restore') {
    await client.query('DELETE FROM workspace_suspension_holds WHERE workspace_id=$1 AND source=$2', [input.workspaceId, source]);
  } else {
    await client.query(`INSERT INTO workspace_suspension_holds (workspace_id, source, public_reason) VALUES ($1,$2,$3)
      ON CONFLICT (workspace_id, source) DO UPDATE SET public_reason=EXCLUDED.public_reason`, [input.workspaceId, source, input.body.publicReason ?? (source === 'admin' ? DEFAULT_ADMIN_SUSPENSION_REASON : null)]);
  }
  await client.query(`UPDATE workspaces SET lifecycle_status = CASE WHEN EXISTS (SELECT 1 FROM workspace_suspension_holds WHERE workspace_id=$1) THEN 'suspended' ELSE 'active' END,
    suspended_at = CASE WHEN EXISTS (SELECT 1 FROM workspace_suspension_holds WHERE workspace_id=$1) THEN COALESCE(suspended_at, NOW()) ELSE NULL END WHERE id=$1`, [input.workspaceId]);
}
export async function mutateWorkspacePolicy(input: PolicyMutationInput): Promise<PolicyMutationResponse> {
  let beforePolicy: Awaited<ReturnType<typeof readPolicySnapshot>>['policy'] | undefined;
  try { return await withTransaction(async client => {
    const { workspaceId, operation, body } = input;
    if (body.requestId !== undefined && body.expectedPolicyVersion === undefined) fail('POLICY_PRECONDITION_REQUIRED', 400, 'expectedPolicyVersion is required whenever requestId is supplied');
    const tokenId = input.audit.adminTokenId ?? '__legacy_unattributed__';
    const locked = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
    if (!locked.rowCount) fail('NOT_FOUND', 404, 'Workspace not found');
    const bodyHash = canonicalPolicyHash({ operation, ...body, source: body.source ?? 'admin', overLimitBehavior: body.overLimitBehavior ?? 'reject' });
    if (body.requestId) {
      const receipt = await client.query<{ body_hash: string; response: PolicyMutationResponse }>(`SELECT body_hash, response FROM workspace_policy_receipts WHERE workspace_id=$1 AND request_id=$2 AND admin_token_id=$3 AND operation=$4 AND created_at >= NOW()-INTERVAL '30 days'`, [workspaceId, body.requestId, tokenId, operation]);
      if (receipt.rowCount) {
        if (receipt.rows[0].body_hash !== bodyHash) fail('IDEMPOTENCY_CONFLICT', 409, 'Request ID has already been used with different content');
        return receipt.rows[0].response;
      }
    }
    const before = await readPolicySnapshot(client, workspaceId);
    beforePolicy = before.policy;
    if (body.expectedPolicyVersion !== undefined && body.expectedPolicyVersion !== before.policy.policyVersion) fail('WORKSPACE_POLICY_VERSION_CONFLICT', 409, 'Workspace policy version changed');
    if (body.workspaceName !== undefined && body.workspaceName !== before.workspace.name) fail('VALIDATION_ERROR', 400, 'Workspace name does not match');
    if (operation === 'suspend' && body.workspaceName !== before.workspace.name) fail('VALIDATION_ERROR', 400, 'Workspace name does not match');
    const hold = before.policy.holds.find(item => item.source === (body.source ?? 'admin'));
    const legacy = body.expectedPolicyVersion === undefined && body.requestId === undefined;
    if (legacy && operation === 'suspend' && hold) fail('WORKSPACE_ALREADY_SUSPENDED', 409, 'Workspace is already suspended');
    if (legacy && operation === 'restore' && !hold) fail('WORKSPACE_ALREADY_ACTIVE', 409, 'Workspace is already active');
    const planKey = operation === 'plan' ? body.planKey! : before.workspace.plan.key;
    if (!Object.hasOwn(workspacePlanCatalog(), planKey)) fail('WORKSPACE_PLAN_NOT_CONFIGURED', 400, 'Workspace plan is not configured');
    const quotaOverrides = operation === 'quotas' ? overrides(body.quotas) : before.workspace.quotaOverrides;
    const limits = effectiveWorkspaceLimits(planKey, quotaOverrides);
    const usage = before.policy.usage;
    const overLimit = { members: usage.members > limits.quotas.members, kubernetesClusters: usage.kubernetesClusters > limits.quotas.kubernetesClusters, virtualMachines: usage.virtualMachines > limits.quotas.virtualMachines };
    const executionOverLimit = EXECUTION_POOLS.some(pool => {
      const limit = limits.executionLimits[pool], used = usage.execution[pool];
      return (limit.maxConcurrentRuns !== null && used.concurrentRuns > limit.maxConcurrentRuns) || (limit.maxOutstandingRuns !== null && used.outstandingRuns > limit.maxOutstandingRuns);
    });
    if ((operation === 'plan' || operation === 'quotas') && body.overLimitBehavior !== 'retain_existing' && (Object.values(overLimit).some(Boolean) || executionOverLimit)) fail('VALIDATION_ERROR', 400, 'Current workspace usage exceeds target policy limits');
    const changed = operation === 'plan' ? planKey !== before.workspace.plan.key : operation === 'quotas'
      ? canonicalPolicyHash(quotaOverrides) !== canonicalPolicyHash(before.workspace.quotaOverrides)
      : operation === 'suspend' ? !hold || hold.publicReason !== (body.publicReason ?? ((body.source ?? 'admin') === 'admin' ? DEFAULT_ADMIN_SUSPENSION_REASON : null)) : Boolean(hold);
    if (changed) {
      if (operation === 'plan') await client.query('UPDATE workspaces SET plan_key=$2 WHERE id=$1', [workspaceId, planKey]);
      else if (operation === 'quotas') await client.query(`INSERT INTO workspace_quota_overrides (workspace_id, members, kubernetes_clusters, virtual_machines, updated_at) VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (workspace_id) DO UPDATE SET members=EXCLUDED.members, kubernetes_clusters=EXCLUDED.kubernetes_clusters, virtual_machines=EXCLUDED.virtual_machines, updated_at=NOW()`, [workspaceId, quotaOverrides.members, quotaOverrides.kubernetesClusters, quotaOverrides.virtualMachines]);
      else await writeHold(client, input);
      await client.query('UPDATE workspaces SET policy_version=policy_version+1 WHERE id=$1', [workspaceId]);
    }
    const after = await readPolicySnapshot(client, workspaceId);
    const response = { before: before.workspace, after: after.workspace, ...(operation === 'plan' ? { usage, overLimit } : {}), policy: after.policy, changed };
    const correlationId = randomUUID();
    await insertAdminAuditEvent({ ...input.audit, workspaceId, metadata: { ...input.audit.metadata, before: policyAuditState(before.policy), after: policyAuditState(after.policy), correlationId, policyRequestId: body.requestId ?? null, beforePolicyVersion: before.policy.policyVersion, policyVersion: after.policy.policyVersion, source: body.source ?? 'admin', changed } }, client);
    if (changed) await insertWorkspaceAuditEvent({
      workspaceId, category: 'workspace', operation: 'write', actorType: 'admin_token',
      actorTokenId: input.audit.adminTokenId === config.PLATFORM_ADMIN_BFF_TOKEN_ID ? 'platform-admin' : input.audit.adminTokenId ?? 'platform-admin',
      eventType: operation === 'plan' || operation === 'quotas' ? `workspace.${operation}.updated.v1` : operation === 'suspend' ? 'workspace.suspended.v1' : 'workspace.restored.v1',
      objectType: 'workspace', objectId: workspaceId, objectName: after.workspace.name,
      summary: `Workspace ${operation} policy updated by administrator`,
      metadata: { correlationId, source: body.source ?? 'admin', publicReason: after.policy.publicReason, before: policyAuditState(before.policy), after: policyAuditState(after.policy), policyVersion: after.policy.policyVersion }
    }, client, 'read_write');
    if (body.requestId) {
      await client.query(`DELETE FROM workspace_policy_receipts WHERE workspace_id=$1 AND request_id=$2 AND admin_token_id=$3 AND operation=$4 AND created_at < NOW()-INTERVAL '30 days'`, [workspaceId, body.requestId, tokenId, operation]);
      await client.query('INSERT INTO workspace_policy_receipts (workspace_id,request_id,body_hash,response,admin_token_id,operation) VALUES ($1,$2,$3,$4::jsonb,$5,$6)', [workspaceId, body.requestId, bodyHash, JSON.stringify(response), tokenId, operation]);
    }
    return response;
  }); } catch (error) {
    if (error instanceof WorkspacePolicyError) await recordPolicyFailure(input, error, beforePolicy);
    throw error;
  }
}
