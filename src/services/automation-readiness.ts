import type { AgentDefinition } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { getAgentDefinition, updateAgentReadiness } from '../store/repository-agents.js';
import { updateWorkflowReadiness } from '../store/repository-workflows.js';
import { resolveCapabilityRoutingMappings } from './capability-routing-resolution.js';

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function computeAgentReadiness(agent: AgentDefinition): Promise<AgentDefinition['readiness']> {
  if (agent.status !== 'active' || agent.reviewState !== 'reviewed') {
    return { status: 'blocked', reasons: ['Agent must be active and reviewed.'] };
  }
  return { status: 'ready', reasons: [] };
}

export async function refreshAgentReadiness(workspaceId: string, agentId: string): Promise<AgentDefinition | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) return null;
  return (await updateAgentReadiness(workspaceId, agentId, await computeAgentReadiness(agent))) || agent;
}

export async function computeWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<NonNullable<WorkflowDefinitionForAccess['readiness']>> {
  return (await resolveWorkflowRoutingSnapshot(workflow)).readiness;
}

export interface WorkflowRoutingSnapshot {
  readiness: NonNullable<WorkflowDefinitionForAccess['readiness']>;
  selectedAgents: AgentDefinition[];
  specialistAgent?: AgentDefinition;
  mappings: CapabilityRoutingMapping[];
}

export async function resolveWorkflowRoutingSnapshot(
  workflow: WorkflowDefinitionForAccess
): Promise<WorkflowRoutingSnapshot> {
  if (workflow.agentIds.length === 0) {
    return {
      readiness: { status: 'blocked', reasons: ['WORKFLOW_AGENT_SELECTION_REQUIRED'] },
      selectedAgents: [],
      mappings: []
    };
  }
  const selected = (await Promise.all(
    workflow.agentIds.map((agentId) => getAgentDefinition(workflow.workspaceId, agentId))
  )).filter((agent): agent is AgentDefinition => Boolean(agent));
  const unavailable = workflow.agentIds.filter((agentId) => !selected.some((agent) => (
    agent.id === agentId
    && agent.status === 'active'
    && agent.reviewState === 'reviewed'
  )));
  if (unavailable.length > 0) {
    return {
      readiness: {
        status: 'blocked',
        reasons: unavailable.map((agentId) => `Selected Agent ${agentId} must remain an active, reviewed specialist.`)
      },
      selectedAgents: selected,
      mappings: []
    };
  }
  const specialistAgent = workflow.executionMode === 'direct' ? selected[0] : undefined;
  if (specialistAgent) {
    return {
      readiness: { status: 'ready', reasons: [] },
      selectedAgents: selected,
      specialistAgent,
      mappings: []
    };
  }
  const requested = unique(selected.flatMap((agent) => agent.semanticCapabilityIds));

  const selectedById = new Map(selected.map((agent) => [agent.id, agent]));
  const mappings = resolveCapabilityRoutingMappings(selected, await listCapabilityRoutingMappings(workflow.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: requested
  }));
  const mappedCapabilityIds = new Set(mappings
    .filter((mapping) => selectedById.has(mapping.agentId))
    .map((mapping) => mapping.capabilityId));
  const unmapped = requested.filter((capabilityId) => !mappedCapabilityIds.has(capabilityId));
  if (unmapped.length > 0) {
    return {
      readiness: {
        status: 'needs_setup',
        reasons: unmapped.map((capabilityId) => (
          `Coordinated runs need an approved Agent route for ${capabilityId}. Review the assigned Agents' capabilities.`
        ))
      },
      selectedAgents: selected,
      mappings
    };
  }
  return {
    readiness: { status: 'ready', reasons: [] },
    selectedAgents: selected,
    mappings
  };
}

export async function refreshWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<WorkflowDefinitionForAccess | null> {
  return (await updateWorkflowReadiness(
    workflow.workspaceId,
    workflow.id,
    await computeWorkflowReadiness(workflow)
  )) || workflow;
}
