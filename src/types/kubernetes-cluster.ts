import type { RunPermissionMode } from './run-permission.js';

export type WriteConfirmationPolicySource = 'cluster_override' | 'deployment_default';
export type PermissionModePolicySource = WriteConfirmationPolicySource;
export type LegacyWriteConfirmationPolicy = {
  effectiveRequired: boolean;
  overrideRequired: boolean | null;
  source: WriteConfirmationPolicySource;
};

export interface KubernetesCluster {
  id: string;
  workspaceId: string;
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  namespaceInclude: string[];
  namespaceExclude: string[];
  permissionMode: RunPermissionMode;
  permissionModeOverride?: RunPermissionMode | null;
  permissionModeSource: PermissionModePolicySource;
  /** @deprecated Use permissionModeOverride. */
  writeConfirmationRequiredOverride?: boolean | null;
  /** @deprecated Use permissionMode fields. */
  writeConfirmationPolicy: LegacyWriteConfirmationPolicy;
  createdAt: string;
  updatedAt: string;
}
