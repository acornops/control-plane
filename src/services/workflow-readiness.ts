import { getWorkflowOptionsCatalog } from '../store/repository-workflows.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';

export async function getWorkflowCapabilityReadinessErrors(
  workspaceId: string,
  scope: CompiledWorkflowAccessScope
): Promise<string[]> {
  const options = await getWorkflowOptionsCatalog(workspaceId);
  const serverOptions = new Map(options.mcpServers.map((option) => [option.value, option]));
  const toolOptions = new Map(options.mcpTools.map((option) => [option.value, option]));
  return [
    ...scope.mcpServers.flatMap((serverId) => {
      const option = serverOptions.get(serverId);
      if (!option) return [`MCP server ${serverId} was deleted or is no longer assigned.`];
      return option.disabled ? [option.disabledReason || `MCP server ${serverId} is unavailable.`] : [];
    }),
    ...scope.tools.flatMap((toolName) => {
      const option = toolOptions.get(toolName);
      if (!option) return [`MCP tool ${toolName} was deleted or is no longer assigned.`];
      return option.disabled ? [option.disabledReason || `MCP tool ${toolName} is unavailable.`] : [];
    })
  ];
}
