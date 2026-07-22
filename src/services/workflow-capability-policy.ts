import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowCapabilityPolicy } from '../types/workflows.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function combinedAgentCapabilityCeiling(agents: AgentDefinition[]): string[] {
  return uniqueSorted(agents.flatMap((agent) => agent.semanticCapabilityIds));
}

export function resolveEffectiveWorkflowCapabilityIds(
  policy: Pick<WorkflowCapabilityPolicy, 'restrictionMode' | 'semanticCapabilityIds'>,
  agents: AgentDefinition[]
): string[] {
  return policy.restrictionMode === 'inherit'
    ? combinedAgentCapabilityCeiling(agents)
    : uniqueSorted(policy.semanticCapabilityIds);
}

export function capabilitiesOutsideAgentCeiling(
  policy: Pick<WorkflowCapabilityPolicy, 'restrictionMode' | 'semanticCapabilityIds'>,
  agents: AgentDefinition[]
): string[] {
  if (policy.restrictionMode === 'inherit') return [];
  const ceiling = new Set(combinedAgentCapabilityCeiling(agents));
  return uniqueSorted(policy.semanticCapabilityIds).filter((capabilityId) => !ceiling.has(capabilityId));
}
