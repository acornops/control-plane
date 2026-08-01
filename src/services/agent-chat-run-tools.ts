import type { Run } from '../types/domain.js';
import { resolveWorkspaceMcpToolSpecs } from './workspace-mcp-tool-specs.js';
import { WEB_SEARCH_TOOL_ID } from './provider-native-tool-ids.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';

interface AgentChatToolSpec {
  name: string;
  server_id?: string;
  tool_name?: string;
  description: string;
  capability: 'read' | 'write';
  input_schema: Record<string, unknown>;
}

export async function resolveAgentChatRunTools(run: Run): Promise<{
  allowedToolNames: string[];
  allowedToolOperations: Record<string, 'read' | 'write'>;
  allowedToolRefs: Array<{ serverId: string; toolName: string }>;
  allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }>;
  platformFunctions: Array<{ id: string; model_alias: string }>;
  allowedToolSpecs: AgentChatToolSpec[];
}> {
  const scope = run.compiledAccessScope;
  const agent = run.agentSnapshot;
  if (run.conversationKind !== 'agent_chat' || !scope || !agent) {
    throw new Error('Agent chat run is missing its pinned capability snapshot');
  }

  const grantedMcpKeys = new Set(scope.mcpTools.map((ref) => `${ref.serverId}\u0000${ref.toolName}`));
  const mcpTools = agent.mcpInstallations.flatMap((installation) => {
    if (!installation.enabled) return [];
    return installation.tools.filter((tool) => tool.enabled && tool.reviewState === 'approved'
      && grantedMcpKeys.has(`${tool.serverId}\u0000${tool.toolName}`)
      && scope.tools.includes(tool.alias)
      && scope.toolOperations[tool.alias] === tool.capability);
  });
  const workspaceNativeDefinitions = scope.tools
    .map((toolId) => getWorkspaceNativeTool(toolId))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    .filter((tool) => tool.invocationScopes.includes('agent_chat'));
  const providerNativeIds = new Set<string>(scope.tools.filter((tool) => tool === WEB_SEARCH_TOOL_ID));

  const allowedToolNames: string[] = [];
  const allowedToolOperations: Record<string, 'read' | 'write'> = {};
  const allowedToolRefs = mcpTools.map((tool) => ({ serverId: tool.serverId, toolName: tool.toolName }));
  const allowedNativeTools = [...providerNativeIds].map((id) => ({
    id,
    config: structuredClone(scope.nativeToolConfigs[id] || {})
  }));
  const platformFunctions = workspaceNativeDefinitions.map((tool) => ({ id: tool.id, model_alias: tool.modelAlias }));
  const allowedToolSpecs: AgentChatToolSpec[] = [];

  for (const tool of workspaceNativeDefinitions) {
    allowedToolNames.push(tool.modelAlias);
    allowedToolOperations[tool.modelAlias] = tool.approvalOperation;
    allowedToolSpecs.push({
      name: tool.modelAlias,
      description: tool.description,
      capability: tool.approvalOperation,
      input_schema: tool.inputSchema
    });
  }

  for (const tool of await resolveWorkspaceMcpToolSpecs({
    workspaceId: run.workspaceId,
    runId: run.id,
    mode: scope.mode,
    refs: scope.mcpTools
  })) {
    allowedToolNames.push(tool.name);
    allowedToolOperations[tool.name] = tool.capability;
    allowedToolRefs.push({ serverId: tool.server_id, toolName: tool.tool_name });
    allowedToolSpecs.push(tool);
  }

  for (const tool of mcpTools) {
    allowedToolNames.push(tool.alias);
    allowedToolOperations[tool.alias] = tool.capability;
    allowedToolSpecs.push({
      name: tool.alias,
      server_id: tool.serverId,
      tool_name: tool.toolName,
      description: tool.description || `Execute reviewed MCP tool "${tool.toolName}".`,
      capability: tool.capability,
      input_schema: tool.inputSchema || { type: 'object' }
    });
  }

  return {
    allowedToolNames: [...new Set(allowedToolNames)],
    allowedToolOperations,
    allowedToolRefs,
    allowedNativeTools,
    platformFunctions,
    allowedToolSpecs
  };
}
