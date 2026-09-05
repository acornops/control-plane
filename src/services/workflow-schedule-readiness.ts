import type { RunPrincipalRef } from '../types/agents.js';
import type { WorkflowAccessActor, WorkflowDefinitionForAccess } from '../types/workflows.js';
import { compileWorkflowScope } from './workflow-scope-compiler.js';
import { getWorkflowCapabilityReadinessReport, type McpReadinessReport } from './mcp-readiness.js';
import { resolveMcpUserPrincipal } from './mcp-user-principal.js';

export async function getWorkflowScheduleMcpReadinessReport(input: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  principal: RunPrincipalRef;
}): Promise<McpReadinessReport> {
  const principal = input.principal.type === 'user'
    ? await resolveMcpUserPrincipal(input.workspaceId, input.principal.id)
    : input.principal;
  const compiled = await compileWorkflowScope({
    workflow: input.workflow,
    actor: input.actor,
    principal
  });
  return getWorkflowCapabilityReadinessReport(
    input.workspaceId,
    compiled.scope,
    { principal: compiled.scope.principal }
  );
}
