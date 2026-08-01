import type { WorkspaceCapability, WorkspacePermissions } from '../auth/authorization.js';

export type CapabilityAccessMode = 'read_only' | 'read_write';
export type CapabilityRestrictionMode = 'inherit' | 'restrict';

export interface CapabilityAccessActor {
  userId: string;
  role: string;
  permissions: WorkspacePermissions;
}

export interface CapabilityPermissionRequirement {
  requiredPermissions: WorkspaceCapability[];
  grantedCapabilities: WorkspaceCapability[];
}
