import type { AgentDefinition } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';

/**
 * Workspace-native tool assignment is the authorization decision. These tools
 * are owned and reviewed in control-plane code, so coordinated routing must not
 * require a second independently reviewed database record for the same grant.
 */
export function resolveCapabilityRoutingMappings(
  agents: AgentDefinition[],
  persistedMappings: CapabilityRoutingMapping[]
): CapabilityRoutingMapping[] {
  const resolved = [...persistedMappings];
  const routed = new Set(resolved.map((mapping) => `${mapping.agentId}\0${mapping.capabilityId}`));

  for (const agent of agents) {
    for (const toolId of agent.tools) {
      const tool = getWorkspaceNativeTool(toolId);
      if (!tool || !agent.semanticCapabilityIds.includes(tool.semanticCapabilityId)) continue;
      const routeKey = `${agent.id}\0${tool.semanticCapabilityId}`;
      if (routed.has(routeKey)) continue;
      resolved.push({
        id: `assigned-native:${agent.id}:${tool.id}`,
        workspaceId: agent.workspaceId,
        capabilityId: tool.semanticCapabilityId,
        agentId: agent.id,
        status: 'active',
        reviewState: 'reviewed',
        priority: 100,
        mcpTools: [],
        nativeToolIds: [tool.id],
        skillIds: [],
        createdBy: agent.createdBy,
        reviewedBy: agent.createdBy,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt
      });
      routed.add(routeKey);
    }
  }

  return resolved.sort((left, right) => (
    left.capabilityId.localeCompare(right.capabilityId)
    || left.priority - right.priority
    || left.id.localeCompare(right.id)
  ));
}
