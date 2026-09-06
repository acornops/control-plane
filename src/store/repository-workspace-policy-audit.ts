import { insertAdminAuditEvent } from './repository-admin-audit.js';
import type { PolicyMutationInput } from './repository-workspace-policy.js';
import type { readPolicySnapshot } from './repository-workspace-policy-read.js';
import { WorkspacePolicyError } from '../types/workspace-policy.js';

type Policy = Awaited<ReturnType<typeof readPolicySnapshot>>['policy'];
export function policyAuditState(policy: Policy): Record<string, unknown> {
  return { planKey: policy.plan.key, quotaOverrides: policy.quotaOverrides,
    effectiveLimits: { quotas: policy.effectiveLimits.quotas, executionLimits: policy.effectiveLimits.executionLimits },
    lifecycleStatus: policy.lifecycleStatus, suspendedAt: policy.suspendedAt,
    holds: policy.holds, policyVersion: policy.policyVersion };
}
export async function recordPolicyFailure(input: PolicyMutationInput, error: WorkspacePolicyError, before?: Policy): Promise<void> {
  await insertAdminAuditEvent({ ...input.audit, workspaceId: input.workspaceId, outcome: 'failure', metadata: {
    ...(before ? { before: policyAuditState(before), usage: before.usage, confirmationMatched: input.body.workspaceName === undefined ? null : input.body.workspaceName === before.workspaceName } : {}),
    errorCode: error.code, operation: input.operation, policyRequestId: input.body.requestId ?? null,
    expectedPolicyVersion: input.body.expectedPolicyVersion ?? null, source: input.body.source ?? 'admin',
    requestedPlanKey: input.body.planKey ?? null, requestedQuotaOverrides: input.body.quotas ?? null,
    overLimitBehavior: input.body.overLimitBehavior ?? 'reject'
  } });
  error.auditRecorded = true;
}
