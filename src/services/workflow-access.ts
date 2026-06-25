import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';

export type WorkflowAccessDeniedCode =
  | 'WORKFLOW_PERMISSION_DENIED'
  | 'WORKFLOW_CONTEXT_GRANT_DENIED';

export class WorkflowAccessDeniedError extends Error {
  readonly code: WorkflowAccessDeniedCode;
  readonly missingPermissions: WorkspaceCapability[];
  readonly missingContextGrants: string[];

  constructor(
    code: WorkflowAccessDeniedCode,
    message: string,
    options: {
      missingPermissions?: WorkspaceCapability[];
      missingContextGrants?: string[];
    } = {}
  ) {
    super(message);
    this.name = 'WorkflowAccessDeniedError';
    this.code = code;
    this.missingPermissions = options.missingPermissions || [];
    this.missingContextGrants = options.missingContextGrants || [];
  }
}

export interface CompileWorkflowAccessInput {
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
}

export type { WorkflowDefinitionForAccess } from '../types/workflows.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

function requiredRunCapability(workflow: WorkflowDefinitionForAccess): WorkspaceCapability {
  return workflow.policy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

function requiredPermissionsFor(workflow: WorkflowDefinitionForAccess): WorkspaceCapability[] {
  return uniqueSorted([...workflow.requiredPermissions, requiredRunCapability(workflow)]) as WorkspaceCapability[];
}

function compileToolOperations(tools: string[], mode: WorkflowDefinitionForAccess['policy']['mode']): Record<string, WorkspaceAuditOperation> {
  const operation: WorkspaceAuditOperation = mode === 'read_write' ? 'write' : 'read';
  return Object.fromEntries(tools.map((tool) => [tool, operation]));
}

function compileApprovalGates(workflow: WorkflowDefinitionForAccess): string[] {
  return uniqueSorted([
    ...workflow.policy.approvalRequirements,
    ...workflow.steps
      .filter((step) => step.approvalRequired)
      .map((step) => step.title)
  ]);
}

export function compileWorkflowAccessScope(input: CompileWorkflowAccessInput): CompiledWorkflowAccessScope {
  const requiredPermissions = requiredPermissionsFor(input.workflow);
  const missingPermissions = requiredPermissions.filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length > 0) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_PERMISSION_DENIED',
      'Current workspace role cannot run this workflow.',
      { missingPermissions }
    );
  }

  const contextGrants = uniqueSorted(input.workflow.steps.flatMap((step) => step.contextGrants));
  const approvedContextGrants = new Set(input.approvedContextGrants);
  const missingContextGrants = contextGrants.filter((grant) => !approvedContextGrants.has(grant));
  if (missingContextGrants.length > 0) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CONTEXT_GRANT_DENIED',
      'Workflow context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }

  const tools = uniqueSorted(input.workflow.steps.flatMap((step) => step.allowedTools));
  const workflowMcpServers = input.workflow.enabledMcpServers || [];
  const workflowSkills = input.workflow.enabledSkills || [];
  const toolOperations = compileToolOperations(tools, input.workflow.policy.mode);

  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    workflowVersion: input.workflow.version,
    actor: {
      userId: input.actor.userId,
      role: input.actor.role
    },
    mode: input.workflow.policy.mode,
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: workflowMcpServers.length > 0
      ? uniqueSorted(workflowMcpServers)
      : uniqueSorted(input.workflow.steps.flatMap((step) => step.allowedMcpServers)),
    tools,
    toolOperations,
    enabledSkills: workflowSkills.length > 0
      ? uniqueSorted(workflowSkills)
      : uniqueSorted(input.workflow.steps.flatMap((step) => step.enabledSkills)),
    contextGrants,
    approvalGates: compileApprovalGates(input.workflow),
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      workflow_version: input.workflow.version,
      permissions: {
        allowed_tools: tools,
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants
      }
    }
  };
}
