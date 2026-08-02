import type { RunPrincipalRef } from '../types/agents.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import type { WorkflowAccessActor, WorkflowDefinitionForAccess } from '../types/workflows.js';
import { compileWorkflowScope } from './workflow-scope-compiler.js';
import { getWorkflowCapabilityReadinessReport, type McpReadinessReport } from './mcp-readiness.js';

export async function getWorkflowScheduleMcpReadinessReport(input: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  principal: RunPrincipalRef;
  resolution: {
    bindings: PromptResourceBinding[];
    promptDigest: string;
    bindingDigest: string;
  };
}): Promise<McpReadinessReport> {
  const compiled = await compileWorkflowScope({
    workflow: input.workflow,
    actor: input.actor,
    resourceBindings: input.resolution.bindings,
    promptDigest: input.resolution.promptDigest,
    bindingDigest: input.resolution.bindingDigest
  });
  return getWorkflowCapabilityReadinessReport(
    input.workspaceId,
    compiled.scope,
    { principal: input.principal }
  );
}
