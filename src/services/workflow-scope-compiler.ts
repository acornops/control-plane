import { resolveWorkflowRoutingSnapshot } from './automation-readiness.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling,
  WorkflowAccessDeniedError
} from './workflow-access.js';
import type { AgentDefinition } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';

export async function compileWorkflowScope(input: {
  workflow: WorkflowDefinitionForAccess;
  actor: WorkflowAccessActor;
  sessionCeiling?: boolean;
}): Promise<{
  scope: CompiledWorkflowAccessScope;
  selectedAgents: AgentDefinition[];
  specialistAgent?: AgentDefinition;
  mappings: CapabilityRoutingMapping[];
}> {
  const snapshot = await resolveWorkflowRoutingSnapshot(input.workflow);
  const { readiness, selectedAgents, specialistAgent, mappings } = snapshot;
  if (readiness.status !== 'ready') {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
      readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.'
    );
  }
  if (input.sessionCeiling) {
    return {
      selectedAgents,
      specialistAgent,
      mappings,
      scope: compileWorkflowSessionCeiling({
        workflow: input.workflow,
        selectedAgents,
        specialistAgent,
        mappings,
        actor: input.actor
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
      actor: input.actor
    })
  };
}
