import { getWorkflowOptionsCatalog } from '../store/repository-workflows.js';
import type { TargetSummary } from '../types/domain.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';
import { loadWorkflowBuiltInMcpCatalogForTarget } from './workflow-built-in-mcp-catalog.js';

export async function getWorkflowCapabilityReadinessErrors(
  workspaceId: string,
  scope: CompiledWorkflowAccessScope,
  target?: TargetSummary
): Promise<string[]> {
  const options = target ? undefined : await getWorkflowOptionsCatalog(workspaceId);
  const targetCatalog = target
    ? await loadWorkflowBuiltInMcpCatalogForTarget(workspaceId, target)
    : undefined;
  const serverOptions = new Map((options?.mcpServers || [targetCatalog && {
    value: targetCatalog.server.id,
    disabled: !targetCatalog.server.enabled,
    disabledReason: 'The built-in AcornOps Kubernetes Tools server is unavailable on this target.'
  }].filter(Boolean)).map((option) => [option!.value, option!]));
  const toolOptions = new Map((options?.mcpTools || targetCatalog?.tools.map((tool) => ({
    value: tool.name,
    disabled: !tool.enabled,
    disabledReason: `Built-in MCP tool ${tool.name} is disabled on this target.`
  })) || []).map((option) => [option.value, option]));
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
