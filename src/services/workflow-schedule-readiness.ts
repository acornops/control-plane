import type { RunPrincipalRef } from '../types/agents.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import type { WorkflowAccessActor, WorkflowDefinitionForAccess } from '../types/workflows.js';
import { isTargetType, type TargetSummary } from '../types/domain.js';
import { repo } from '../store/repository.js';
import { compileWorkflowScope } from './workflow-scope-compiler.js';
import { WorkflowAccessDeniedError } from './workflow-access.js';
import { getWorkflowCapabilityReadinessReport, type McpReadinessReport } from './workflow-readiness.js';
import { promptResourceRegistry } from './prompt-resources/index.js';

export async function getWorkflowScheduleMcpReadinessReport(input: {
  workspaceId: string;
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  principal: RunPrincipalRef;
  approvedContextGrants: string[];
  resolution: {
    bindings: PromptResourceBinding[];
    promptDigest: string;
    bindingDigest: string;
  };
}): Promise<McpReadinessReport> {
  const runtimeProjection = promptResourceRegistry.projectRuntime(
    input.resolution.bindings,
    `workflow-schedule-preflight:${input.workflow.id}`
  );
  const projectedTarget = runtimeProjection.targetRoute && typeof runtimeProjection.targetRoute === 'object'
    ? runtimeProjection.targetRoute as Record<string, unknown>
    : undefined;
  const targetRoute = projectedTarget
    && typeof projectedTarget.id === 'string'
    && typeof projectedTarget.targetType === 'string'
    && isTargetType(projectedTarget.targetType)
    ? { id: projectedTarget.id, targetType: projectedTarget.targetType }
    : undefined;
  const target: TargetSummary | undefined = targetRoute
    ? await repo.getTarget(input.workspaceId, targetRoute.id) || undefined
    : undefined;
  if (targetRoute && !target) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_TARGET_SCOPE_DENIED',
      'The target referenced by this schedule is no longer available.'
    );
  }

  const compiled = await compileWorkflowScope({
    workflow: input.workflow,
    actor: input.actor,
    approvedContextGrants: input.approvedContextGrants,
    targetRoute,
    resourceBindings: input.resolution.bindings,
    promptDigest: input.resolution.promptDigest,
    bindingDigest: input.resolution.bindingDigest
  });
  return getWorkflowCapabilityReadinessReport(
    input.workspaceId,
    compiled.scope,
    target,
    { principal: input.principal }
  );
}
