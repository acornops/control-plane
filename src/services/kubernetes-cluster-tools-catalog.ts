import { listConfiguredRoleTemplates } from '../auth/authorization.js';
import { config } from '../config.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import { McpServerConfig, McpToolConfig } from './mcp-registry-client.js';

type EffectiveDisabledReason = 'server_disabled' | 'agent_write_disabled' | null;

export function getMcpCatalogEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_mcp'))
    .map((role) => role.key);
}

function isBuiltinServer(server: Pick<McpServerConfig, 'server_name' | 'server_url'>): boolean {
  return server.server_name === config.BUILTIN_MCP_SERVER_NAME || server.server_url === config.BUILTIN_MCP_SERVER_URL;
}

function normalizeCapability(value: unknown): 'read' | 'write' {
  return value === 'read' ? 'read' : 'write';
}

interface NormalizedTool {
  name: string;
  description: string;
  capability: 'read' | 'write';
  version: string;
  source: 'builtin' | 'mcp';
  serverUrl: string;
  enabledConfigured: boolean;
  enabledEffective: boolean;
  effectiveDisabledReason: EffectiveDisabledReason;
}

interface ToolCounts {
  total: number;
  enabledConfigured: number;
  enabledEffective: number;
  writeConfigured: number;
  writeEffective: number;
}

export interface KubernetesClusterToolCatalogItem {
  name: string;
  description: string;
  capability: 'read' | 'write';
  version: string;
  source: 'builtin' | 'mcp';
  enabledConfigured: boolean;
  enabledEffective: boolean;
  effectiveDisabledReason: EffectiveDisabledReason;
}

export interface KubernetesClusterToolCatalogServer {
  id: string;
  name: string;
  url: string;
  type: 'builtin' | 'mcp';
  enabled: boolean;
  isSystem: boolean;
  canDelete: boolean;
  canEditConnection: boolean;
  canToggle: boolean;
  authType: 'none' | 'bearer_token' | 'custom_header';
  publicHeaders?: Record<string, string>;
  connectionStatus: 'unknown' | 'ok' | 'error';
  lastDiscoveryAt: string | null;
  lastDiscoveryError: string | null;
  toolCounts: ToolCounts;
  tools: KubernetesClusterToolCatalogItem[];
}

export interface KubernetesClusterToolCatalogResponse {
  workspaceId: string;
  clusterId: string;
  permissions: {
    canEdit: boolean;
    editableRoles: ReadonlyArray<string>;
  };
  servers: KubernetesClusterToolCatalogServer[];
}

export interface TargetToolCatalogResponse {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  permissions: {
    canEdit: boolean;
    editableRoles: ReadonlyArray<string>;
  };
  servers: KubernetesClusterToolCatalogServer[];
}

function summarizeToolCounts(tools: NormalizedTool[]): ToolCounts {
  const total = tools.length;
  const enabledConfigured = tools.filter((tool) => tool.enabledConfigured).length;
  const enabledEffective = tools.filter((tool) => tool.enabledEffective).length;
  const writeConfigured = tools.filter((tool) => tool.capability === 'write' && tool.enabledConfigured).length;
  const writeEffective = tools.filter((tool) => tool.capability === 'write' && tool.enabledEffective).length;
  return {
    total,
    enabledConfigured,
    enabledEffective,
    writeConfigured,
    writeEffective
  };
}

function createSyntheticServerForUnboundTool(tool: McpToolConfig, targetType: TargetType): McpServerConfig {
  const isBuiltin = tool.source === 'builtin';
  return {
    id: isBuiltin ? `builtin-${tool.name}` : `synthetic-${tool.name}`,
    workspace_id: '',
    target_id: '',
    target_type: targetType,
    server_name: isBuiltin ? config.BUILTIN_MCP_SERVER_NAME : 'remote-mcp-server',
    server_url: isBuiltin ? config.BUILTIN_MCP_SERVER_URL : tool.mcp_server_url || `tool://${tool.name}`,
    enabled: true,
    auth_type: 'none',
    connection_status: 'unknown',
    last_discovery_at: null,
    last_discovery_error: null,
    tools: []
  };
}

export function composeKubernetesClusterToolsCatalog(params: {
  workspaceId: string;
  clusterId: string;
  canEdit: boolean;
  tools: McpToolConfig[];
  servers: McpServerConfig[];
  overrides: Record<string, boolean>;
  targetSupportsWrite: boolean;
}): KubernetesClusterToolCatalogResponse {
  const catalog = composeTargetToolsCatalog({
    workspaceId: params.workspaceId,
    targetId: params.clusterId,
    targetType: KUBERNETES_TARGET_TYPE,
    canEdit: params.canEdit,
    tools: params.tools,
    servers: params.servers,
    overrides: params.overrides,
    targetSupportsWrite: params.targetSupportsWrite
  });
  return {
    workspaceId: catalog.workspaceId,
    clusterId: params.clusterId,
    permissions: catalog.permissions,
    servers: catalog.servers
  };
}

export function composeTargetToolsCatalog(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  canEdit: boolean;
  tools: McpToolConfig[];
  servers: McpServerConfig[];
  overrides: Record<string, boolean>;
  targetSupportsWrite: boolean;
}): TargetToolCatalogResponse {
  const { workspaceId, targetId, targetType, canEdit, tools, overrides, targetSupportsWrite } = params;

  const serverByUrl = new Map<string, McpServerConfig>();
  for (const server of params.servers) {
    serverByUrl.set(server.server_url, server);
  }

  // Ensure all tools are grouped, even if server metadata is temporarily missing.
  for (const tool of tools) {
    if (serverByUrl.has(tool.mcp_server_url)) continue;
    const synthetic = createSyntheticServerForUnboundTool(tool, targetType);
    serverByUrl.set(synthetic.server_url, synthetic);
  }

  const hasBuiltinServer = [...serverByUrl.values()].some((server) => isBuiltinServer(server));
  if (!hasBuiltinServer) {
    serverByUrl.set(config.BUILTIN_MCP_SERVER_URL, {
      id: 'builtin-system-server',
      workspace_id: workspaceId,
      target_id: targetId,
      target_type: targetType,
      server_name: config.BUILTIN_MCP_SERVER_NAME,
      server_url: config.BUILTIN_MCP_SERVER_URL,
      enabled: true,
      auth_type: 'none',
      connection_status: 'unknown',
      last_discovery_at: null,
      last_discovery_error: null,
      tools: []
    });
  }

  const servers: KubernetesClusterToolCatalogServer[] = [];
  for (const server of serverByUrl.values()) {
    const isBuiltin = isBuiltinServer(server);
    const isPlaceholder = !isBuiltin && (server.workspace_id !== workspaceId || server.target_id !== targetId);
    const toolRows = tools
      .filter((tool) => tool.mcp_server_url === server.server_url)
      .map((tool) => {
        const enabledConfigured = Object.prototype.hasOwnProperty.call(overrides, tool.name)
          ? overrides[tool.name]
          : Boolean(tool.enabled);
        const capability = normalizeCapability(tool.capability);
        const effectiveDisabledReason: EffectiveDisabledReason = !server.enabled && enabledConfigured
          ? 'server_disabled'
          : capability === 'write' && enabledConfigured && !targetSupportsWrite
            ? 'agent_write_disabled'
            : null;
        const enabledEffective = Boolean(server.enabled) && enabledConfigured && effectiveDisabledReason === null;
        return {
          name: tool.name,
          description: tool.description || `Execute tool "${tool.name}"`,
          capability,
          version: tool.version || 'v1',
          source: tool.source === 'builtin' ? ('builtin' as const) : ('mcp' as const),
          serverUrl: server.server_url,
          enabledConfigured,
          enabledEffective,
          effectiveDisabledReason
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    servers.push({
      id: server.id,
      name: isBuiltin ? config.BUILTIN_MCP_SERVER_DISPLAY_NAME : server.server_name,
      url: server.server_url,
      type: isBuiltin ? 'builtin' : 'mcp',
      enabled: Boolean(server.enabled),
      isSystem: isBuiltin,
      canDelete: !isBuiltin && !isPlaceholder,
      canEditConnection: !isBuiltin && !isPlaceholder,
      canToggle: !isPlaceholder,
      authType: server.auth_type,
      publicHeaders: server.public_headers ?? {},
      connectionStatus: isBuiltin
        ? 'ok'
        : server.connection_status === 'ok' || server.connection_status === 'error'
          ? server.connection_status
          : 'unknown',
      lastDiscoveryAt: isBuiltin ? null : server.last_discovery_at ?? null,
      lastDiscoveryError: isBuiltin ? null : server.last_discovery_error ?? null,
      toolCounts: summarizeToolCounts(toolRows),
      tools: toolRows.map((tool) => ({
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        version: tool.version,
        source: tool.source,
        enabledConfigured: tool.enabledConfigured,
        enabledEffective: tool.enabledEffective,
        effectiveDisabledReason: tool.effectiveDisabledReason
      }))
    });
  }

  // Built-in first, then alphabetic for remote servers.
  servers.sort((left, right) => {
    if (left.type === 'builtin' && right.type !== 'builtin') return -1;
    if (left.type !== 'builtin' && right.type === 'builtin') return 1;
    return left.name.localeCompare(right.name);
  });

  return {
    workspaceId,
    targetId,
    targetType,
    ...(targetType === KUBERNETES_TARGET_TYPE ? { clusterId: targetId } : {}),
    permissions: {
      canEdit,
      editableRoles: getMcpCatalogEditableRoles()
    },
    servers
  };
}
