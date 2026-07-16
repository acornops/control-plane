import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuthorization } from '../auth/workspace-authorization.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

export function isExternalIntegrationRequest(req: AuthenticatedRequest): boolean {
  return req.auth.credential?.type === 'external_integration';
}

export function requiredContextGrants(workflow: WorkflowDefinitionForAccess): string[] {
  return [...new Set(workflow.steps.flatMap((step) => step.contextGrants || []))]
    .filter((grant) => typeof grant === 'string' && grant.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function validateApprovedContextGrants(
  workflow: WorkflowDefinitionForAccess,
  approvedContextGrants: string[]
): { extra: string[] } {
  const required = new Set(requiredContextGrants(workflow));
  const approved = new Set(approvedContextGrants);
  return {
    extra: [...approved].filter((grant) => !required.has(grant)).sort((left, right) => left.localeCompare(right))
  };
}

export function externalWorkflowBlocker(
  workflow: WorkflowDefinitionForAccess,
  authz: WorkspaceAuthorization
): string | null {
  if (workflow.status !== 'active') {
    return 'External integrations can only run active workflows.';
  }
  if (workflow.policy.mode !== 'read_only') {
    return 'External integrations can only run read-only workflows.';
  }
  if (workflowApprovalGates(workflow).length > 0) {
    return 'External integrations cannot run workflows that require approval gates.';
  }
  const requiredCapabilities = [...new Set([
    'read_workspace_data',
    'create_sessions',
    'create_read_only_runs',
    ...workflow.requiredPermissions
  ])] as WorkspaceCapability[];
  const missingCapability = requiredCapabilities.find((capability) => !authz.can(capability));
  if (missingCapability) {
    return 'External integration workspace grant does not permit this workflow.';
  }
  return null;
}

export function isExternallyRunnableWorkflow(
  workflow: WorkflowDefinitionForAccess,
  authz: WorkspaceAuthorization
): boolean {
  return externalWorkflowBlocker(workflow, authz) === null;
}

export function workflowAuditActor(req: AuthenticatedRequest): {
  actorUserId: string;
  actorType?: 'external_integration';
  actorTokenId?: string | null;
} {
  const credential = req.auth.credential;
  if (credential?.type === 'external_integration') {
    return {
      actorUserId: req.auth.userId,
      actorType: 'external_integration',
      actorTokenId: req.externalIntegrationClient?.id || credential.integrationId
    };
  }
  return { actorUserId: req.auth.userId };
}

function workflowApprovalGates(workflow: WorkflowDefinitionForAccess): string[] {
  return [
    ...workflow.policy.approvalRequirements,
    ...workflow.steps.filter((step) => step.approvalRequired).map((step) => step.title)
  ].filter(Boolean);
}
