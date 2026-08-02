import type { WorkspaceCapability } from '../auth/authorization.js';

export type WorkflowAccessDeniedCode =
  | 'CAPABILITY_PERMISSION_DENIED'
  | 'CAPABILITY_MAPPING_UNAVAILABLE'
  | 'WORKFLOW_PERMISSION_DENIED'
  | 'WORKFLOW_AGENT_SCOPE_DENIED'
  | 'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE';

export class WorkflowAccessDeniedError extends Error {
  readonly code: WorkflowAccessDeniedCode;
  readonly missingPermissions: WorkspaceCapability[];

  constructor(
    code: WorkflowAccessDeniedCode,
    message: string,
    options: { missingPermissions?: WorkspaceCapability[] } = {}
  ) {
    super(message);
    this.name = 'WorkflowAccessDeniedError';
    this.code = code;
    this.missingPermissions = options.missingPermissions || [];
  }
}

export { WorkflowAccessDeniedError as CapabilityAccessDeniedError };
