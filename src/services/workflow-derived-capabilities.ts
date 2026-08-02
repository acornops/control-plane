import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function summarizeWorkflowAgents(agents: AgentDefinition[]) {
  return {
    mode: agents.some((agent) => agent.permissionMode !== 'read_only')
      ? 'read_write' as const
      : 'read_only' as const,
    semanticCapabilityIds: uniqueSorted(agents.flatMap((agent) => agent.semanticCapabilityIds)),
    contextGrants: uniqueSorted(agents.flatMap((agent) => agent.contextGrants))
  };
}

export async function resolveWorkflowAgentCapabilities(workflow: WorkflowDefinitionForAccess) {
  const agents = (await Promise.all(workflow.agentIds.map((agentId) => (
    getAgentDefinition(workflow.workspaceId, agentId)
  )))).filter((agent): agent is AgentDefinition => Boolean(agent));
  return { agents, ...summarizeWorkflowAgents(agents) };
}
