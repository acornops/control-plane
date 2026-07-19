import { config } from '../config.js';
import type { TargetSummary } from '../types/domain.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import {
  listTargetMcpServers,
  listTargetMcpTools,
  type McpServerConfig,
  type McpToolConfig
} from './mcp-registry-client.js';

export interface WorkflowBuiltInMcpTool {
  name: string;
  description?: string;
  capability: 'read' | 'write';
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  targetIds: string[];
}

export interface WorkflowBuiltInMcpCatalog {
  server: {
    id: string;
    name: string;
    enabled: boolean;
    targetIds: string[];
  };
  tools: WorkflowBuiltInMcpTool[];
}

type CatalogLoader = (
  workspaceId: string,
  targets: TargetSummary[]
) => Promise<WorkflowBuiltInMcpCatalog>;

let catalogLoaderOverride: CatalogLoader | undefined;

export function configureWorkflowBuiltInMcpCatalogForTests(loader?: CatalogLoader): void {
  catalogLoaderOverride = loader;
}

function isBuiltInServer(server: Pick<McpServerConfig, 'server_name' | 'server_url'>): boolean {
  return server.server_name === config.BUILTIN_TARGET_MCP_SERVER_NAME
    || server.server_url === config.BUILTIN_TARGET_MCP_SERVER_URL;
}

function isBuiltInTool(tool: McpToolConfig): boolean {
  return tool.source === 'builtin' && tool.mcp_server_url === config.BUILTIN_TARGET_MCP_SERVER_URL;
}

export async function loadWorkflowBuiltInMcpCatalog(
  workspaceId: string,
  targets: TargetSummary[]
): Promise<WorkflowBuiltInMcpCatalog> {
  if (catalogLoaderOverride) return catalogLoaderOverride(workspaceId, targets);

  const kubernetesTargets = targets.filter((target) => target.targetType === KUBERNETES_TARGET_TYPE);
  const discovered = await Promise.all(kubernetesTargets.map(async (target) => {
    const [servers, tools] = await Promise.all([
      listTargetMcpServers(workspaceId, target.id, target.targetType),
      listTargetMcpTools(workspaceId, target.id, target.targetType, {
        includeServerDisabled: true,
        includeDisabled: true
      })
    ]);
    const server = servers.find(isBuiltInServer);
    return {
      target,
      server,
      tools: tools.filter(isBuiltInTool)
    };
  }));

  const serverTargetIds = discovered
    .filter(({ server }) => Boolean(server?.enabled))
    .map(({ target }) => target.id);
  const tools = new Map<string, WorkflowBuiltInMcpTool>();
  for (const item of discovered) {
    for (const tool of item.tools) {
      const current = tools.get(tool.name);
      const enabled = Boolean(item.server?.enabled) && tool.enabled;
      if (current) {
        current.enabled ||= enabled;
        if (enabled && !current.targetIds.includes(item.target.id)) current.targetIds.push(item.target.id);
        continue;
      }
      tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        capability: tool.capability === 'write' ? 'write' : 'read',
        inputSchema: tool.input_schema || { type: 'object' },
        enabled,
        targetIds: enabled ? [item.target.id] : []
      });
    }
  }

  return {
    server: {
      id: config.BUILTIN_TARGET_MCP_SERVER_NAME,
      name: config.BUILTIN_TARGET_MCP_SERVER_DISPLAY_NAME,
      enabled: serverTargetIds.length > 0,
      targetIds: serverTargetIds
    },
    tools: [...tools.values()].sort((left, right) => left.name.localeCompare(right.name))
  };
}

export async function loadWorkflowBuiltInMcpCatalogForTarget(
  workspaceId: string,
  target: TargetSummary
): Promise<WorkflowBuiltInMcpCatalog> {
  return loadWorkflowBuiltInMcpCatalog(workspaceId, [target]);
}
