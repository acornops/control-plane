import { config } from '../config.js';
import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkflowCapabilityPolicy } from '../types/workflows.js';

export interface EffectiveWorkflowRuntimePolicy {
  maxRuntimeSeconds: number;
  retentionDays: number;
}

export function effectiveWorkflowRuntimePolicy(): EffectiveWorkflowRuntimePolicy {
  return {
    maxRuntimeSeconds: Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)),
    retentionDays: config.TARGET_CHAT_REPORT_RETENTION_DAYS
  };
}

export function withEffectiveWorkflowRuntimePolicy(
  policy: WorkflowCapabilityPolicy
): WorkflowCapabilityPolicy {
  return {
    ...policy,
    ...effectiveWorkflowRuntimePolicy()
  };
}

export function manualWorkflowCapabilityPolicy(): WorkflowCapabilityPolicy {
  return {
    mode: 'read_only',
    restrictionMode: 'inherit',
    semanticCapabilityIds: [],
    contextGrants: ['workspace_metadata'],
    ...effectiveWorkflowRuntimePolicy(),
    approvalRequirements: []
  };
}

export function manualWorkflowRequiredPermissions(): WorkspaceCapability[] {
  return ['read_workspace_data'];
}
