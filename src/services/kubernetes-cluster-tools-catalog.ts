import { listConfiguredRoleTemplates } from '../auth/authorization.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import { McpServerConfig, McpToolConfig } from './mcp-registry-client.js';

type EffectiveDisabledReason = 'server_disabled' | 'agent_disconnected' | 'agent_write_disabled' | null;

export function getMcpCatalogEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_mcp'))
    .map((role) => role.key);
}

function isBuiltinServer(server: Pick<McpServerConfig, 'provenance_type'>): boolean {
  return server.provenance_type === 'builtin';
}

function normalizeCapability(value: unknown): 'read' | 'write' {
  return value === 'read' ? 'read' : 'write';
}

interface NormalizedTool {
  name: string;
  serverId?: string;
  modelAlias?: string;
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
  serverId?: string;
  modelAlias?: string;
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
  authScope: 'none' | 'personal' | 'legacy_shared';
  authHeaderName?: string;
  authHeaderPrefix?: string;
  provenance?: {
    sourceId: string;
    artifactName: string;
    version: string;
    digest: string;
    importedAt: string;
  };
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

export function composeKubernetesClusterToolsCatalog(params: {
  workspaceId: string;
  clusterId: string;
  canEdit: boolean;
  tools: McpToolConfig[];
  servers: McpServerConfig[];
  overrides: Record<string, boolean>;
  targetSupportsWrite: boolean;
  targetAgentConnected: boolean;
}): KubernetesClusterToolCatalogResponse {
  const catalog = composeTargetToolsCatalog({
    workspaceId: params.workspaceId,
    targetId: params.clusterId,
    targetType: KUBERNETES_TARGET_TYPE,
    canEdit: params.canEdit,
    tools: params.tools,
    servers: params.servers,
    overrides: params.overrides,
    targetSupportsWrite: params.targetSupportsWrite,
    targetAgentConnected: params.targetAgentConnected
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
  targetAgentConnected: boolean;
}): TargetToolCatalogResponse {
  const {
    workspaceId,
    targetId,
    targetType,
    canEdit,
    tools,
    overrides,
    targetSupportsWrite,
    targetAgentConnected
  } = params;

  const serverByUrl = new Map<string, McpServerConfig>();
  for (const server of params.servers) {
    serverByUrl.set(server.server_url, server);
  }

  const servers: KubernetesClusterToolCatalogServer[] = [];
  for (const server of serverByUrl.values()) {
    const isBuiltin = isBuiltinServer(server);
    const toolRows = tools
      .filter((tool) => tool.server_id === server.id || (!tool.server_id && tool.mcp_server_url === server.server_url))
      .map((tool) => {
        const enabledConfigured = tool.source === 'builtin' && Object.prototype.hasOwnProperty.call(overrides, tool.name)
          ? overrides[tool.name]
          : tool.enabled !== false;
        const capability = normalizeCapability(tool.capability);
        const effectiveDisabledReason: EffectiveDisabledReason = !server.enabled && enabledConfigured
          ? 'server_disabled'
          : isBuiltin && enabledConfigured && !targetAgentConnected
            ? 'agent_disconnected'
          : capability === 'write' && enabledConfigured && !targetSupportsWrite
            ? 'agent_write_disabled'
            : null;
        const enabledEffective = Boolean(server.enabled) && enabledConfigured && effectiveDisabledReason === null;
        return {
          name: tool.name,
          ...(tool.server_id ? { serverId: tool.server_id } : {}),
          ...(tool.model_alias ? { modelAlias: tool.model_alias } : {}),
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
      name: server.server_name,
      url: server.server_url,
      type: isBuiltin ? 'builtin' : 'mcp',
      enabled: Boolean(server.enabled),
      isSystem: isBuiltin,
      canDelete: !isBuiltin,
      canEditConnection: !isBuiltin,
      canToggle: true,
      authType: server.auth_type,
      authScope: server.auth_scope || (server.auth_type === 'none' ? 'none' : 'legacy_shared'),
      authHeaderName: server.auth_header_name || undefined,
      authHeaderPrefix: server.auth_header_prefix || undefined,
      ...(server.catalog_source_id
        && server.catalog_artifact_name
        && server.catalog_version
        && server.catalog_digest
        && server.catalog_imported_at
        ? { provenance: {
            sourceId: server.catalog_source_id,
            artifactName: server.catalog_artifact_name,
            version: server.catalog_version,
            digest: server.catalog_digest,
            importedAt: server.catalog_imported_at
          } }
        : {}),
      publicHeaders: server.public_headers ?? {},
      connectionStatus: isBuiltin
        ? targetAgentConnected ? 'ok' : 'error'
        : server.connection_status === 'ok' || server.connection_status === 'error'
          ? server.connection_status
          : 'unknown',
      lastDiscoveryAt: isBuiltin ? null : server.last_discovery_at ?? null,
      lastDiscoveryError: isBuiltin ? null : server.last_discovery_error ?? null,
      toolCounts: summarizeToolCounts(toolRows),
      tools: toolRows.map((tool) => ({
        name: tool.name,
        ...(tool.serverId ? { serverId: tool.serverId } : {}),
        ...(tool.modelAlias ? { modelAlias: tool.modelAlias } : {}),
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
