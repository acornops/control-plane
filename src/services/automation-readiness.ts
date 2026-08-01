import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { getAgentDefinition, updateAgentReadiness } from '../store/repository-agents.js';
import { updateWorkflowReadiness } from '../store/repository-workflows.js';
import { capabilitiesOutsideAgentCeiling, resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function computeAgentReadiness(agent: AgentDefinition): Promise<AgentDefinition['readiness']> {
  if (agent.status !== 'active' || agent.reviewState !== 'reviewed') {
    return { status: 'blocked', reasons: ['Agent must be active and reviewed.'] };
  }
  const mappings = await listCapabilityRoutingMappings(agent.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: agent.semanticCapabilityIds
  });
  const mapped = new Set(mappings
    .filter((mapping) => mapping.agentId === agent.id)
    .map((mapping) => mapping.capabilityId));
  const missing: string[] = [];
  for (const capabilityId of agent.semanticCapabilityIds) {
    if (!mapped.has(capabilityId)) {
      missing.push(capabilityId);
    }
  }
  return missing.length > 0
    ? { status: 'needs_setup', reasons: missing.map((capabilityId) => `No active reviewed capability mapping is configured for ${capabilityId}.`) }
    : { status: 'ready', reasons: [] };
}

export async function refreshAgentReadiness(workspaceId: string, agentId: string): Promise<AgentDefinition | null> {
  const agent = await getAgentDefinition(workspaceId, agentId);
  if (!agent) return null;
  return (await updateAgentReadiness(workspaceId, agentId, await computeAgentReadiness(agent))) || agent;
}

export async function computeWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<NonNullable<WorkflowDefinitionForAccess['readiness']>> {
  if (workflow.agentIds.length === 0) {
    return { status: 'blocked', reasons: ['WORKFLOW_AGENT_SELECTION_REQUIRED'] };
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
      status: 'blocked',
      reasons: unavailable.map((agentId) => `Selected Agent ${agentId} must remain an active, reviewed specialist.`)
    };
  }
  const requested = resolveEffectiveWorkflowCapabilityIds(workflow.capabilityPolicy, selected);
  const outside = capabilitiesOutsideAgentCeiling(workflow.capabilityPolicy, selected);
  if (outside.length > 0) {
    return { status: 'blocked', reasons: outside.map((capabilityId) => `Selected Agents do not include ${capabilityId}.`) };
  }

  const selectedById = new Map(selected.map((agent) => [agent.id, agent]));
  const mappings = await listCapabilityRoutingMappings(workflow.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: requested
  });
  const eligibleMappings = mappings.filter((mapping) => {
    const agent = selectedById.get(mapping.agentId);
    return Boolean(agent);
  });
  const unmapped: string[] = [];
  for (const capabilityId of requested) {
    const capabilityMappings = eligibleMappings.filter((mapping) => mapping.capabilityId === capabilityId);
    if (!capabilityMappings.length) {
      unmapped.push(capabilityId);
      continue;
    }
  }
  if (unmapped.length > 0) {
    return {
      status: 'needs_setup',
      reasons: unmapped.map((capabilityId) => `No selected specialist has an active reviewed mapping for ${capabilityId}.`)
    };
  }
  return { status: 'ready', reasons: [] };
}

export async function refreshWorkflowReadiness(workflow: WorkflowDefinitionForAccess): Promise<WorkflowDefinitionForAccess | null> {
  return (await updateWorkflowReadiness(
    workflow.workspaceId,
    workflow.id,
    await computeWorkflowReadiness(workflow)
  )) || workflow;
}
