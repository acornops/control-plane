import type { AuthenticatedRequest } from '../auth/middleware.js';
import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuthorization } from '../auth/workspace-authorization.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { resolveWorkflowAgentCapabilities } from '../services/workflow-derived-capabilities.js';

export function isExternalIntegrationRequest(req: AuthenticatedRequest): boolean {
  return req.auth.credential?.type === 'external_integration';
}

export async function validateApprovedContextGrants(
  workflow: WorkflowDefinitionForAccess,
  approvedContextGrants: string[]
): Promise<{ extra: string[] }> {
  const required = new Set((await resolveWorkflowAgentCapabilities(workflow)).contextGrants);
  const approved = new Set(approvedContextGrants);
  return {
    extra: [...approved].filter((grant) => !required.has(grant)).sort((left, right) => left.localeCompare(right))
  };
}

export async function externalWorkflowBlocker(
  workflow: WorkflowDefinitionForAccess,
  authz: WorkspaceAuthorization
): Promise<string | null> {
  if (workflow.status !== 'active') {
    return 'External integrations can only run active workflows.';
  }
  const runCapability: WorkspaceCapability = (await resolveWorkflowAgentCapabilities(workflow)).mode === 'read_write'
    ? 'create_read_write_runs'
    : 'create_read_only_runs';
  const requiredCapabilities = [...new Set([
    'read_workspace_data',
    'create_sessions',
    runCapability
  ])] as WorkspaceCapability[];
  const missingCapability = requiredCapabilities.find((capability) => !authz.can(capability));
  if (missingCapability) {
    return 'External integration workspace grant does not permit this workflow.';
  }
  return null;
}

export async function isExternallyRunnableWorkflow(
  workflow: WorkflowDefinitionForAccess,
  authz: WorkspaceAuthorization
): Promise<boolean> {
  return (await externalWorkflowBlocker(workflow, authz)) === null;
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
