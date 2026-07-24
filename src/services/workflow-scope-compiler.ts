import { computeWorkflowReadiness } from './automation-readiness.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling,
  WorkflowAccessDeniedError
} from './workflow-access.js';
import { resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';

export async function compileWorkflowScope(input: {
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  targetRoute?: { id: string; targetType: 'kubernetes' | 'virtual_machine' };
  resourceBindings?: CompiledWorkflowAccessScope['resourceBindings'];
  promptDigest?: string;
  bindingDigest?: string;
  resolutionPhase?: 'session_ceiling' | 'run_exact';
}): Promise<{
  scope: CompiledWorkflowAccessScope;
  selectedAgents: Array<NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>>;
  specialistAgent?: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>;
  mappings: CapabilityRoutingMapping[];
}> {
  const readiness = await computeWorkflowReadiness(input.workflow);
  if (readiness.status !== 'ready') {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
      readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.'
    );
  }
  const selectedAgents = (await Promise.all(input.workflow.agentIds.map((agentId) => (
    getAgentDefinition(input.workflow.workspaceId, agentId)
  )))).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  if (selectedAgents.length !== input.workflow.agentIds.length) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      'Workflow routing for the selected Agents is unavailable.'
    );
  }
  const specialistAgent = input.workflow.executionMode === 'direct' ? selectedAgents[0] : undefined;
  const effectiveCapabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, selectedAgents);
  const mappings = await listCapabilityRoutingMappings(input.workflow.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: effectiveCapabilityIds
  });
  if (input.resolutionPhase === 'session_ceiling') {
    return {
      selectedAgents,
      specialistAgent,
      mappings,
      scope: compileWorkflowSessionCeiling({
        workflow: input.workflow,
        selectedAgents,
        specialistAgent,
        mappings,
        actor: input.actor,
        approvedContextGrants: input.approvedContextGrants
      })
    };
  }
  return {
    selectedAgents,
    specialistAgent,
    mappings,
    scope: compileWorkflowAccessScope({
      workflow: input.workflow,
      selectedAgents,
      specialistAgent,
      mappings,
      actor: input.actor,
      approvedContextGrants: input.approvedContextGrants,
      targetRoute: input.targetRoute,
      resourceBindings: input.resourceBindings,
      promptDigest: input.promptDigest,
      bindingDigest: input.bindingDigest
    })
  };
}
