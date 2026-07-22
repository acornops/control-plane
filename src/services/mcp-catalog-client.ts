import { TargetType } from '../types/domain.js';
import type { McpServerConfig } from './mcp-registry-client.js';
import {
  createGatewayRequestOptions,
  fetchGateway,
  LlmGatewayHttpError,
  parseGatewayResponse
} from './llm-gateway-admin-client.js';

export interface CatalogBindingConfig {
  id: string;
  artifact_kind: 'mcp_server' | 'agent_skill';
  adapter_type: string;
  adapter_base_path: string;
  sync_status: 'pending' | 'syncing' | 'ready' | 'error';
  last_sync_at?: string | null;
  last_sync_error?: string | null;
}

export interface CatalogSourceConfig {
  id: string;
  workspace_id: string;
  display_name: string;
  base_url: string;
  auth_type: 'none' | 'bearer_token' | 'custom_header';
  credential_configured: boolean;
  auth_header_name?: string | null;
  network_route: 'direct' | 'connector';
  enabled: boolean;
  management_mode: 'workspace' | 'bootstrap';
  bindings: CatalogBindingConfig[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CatalogSourceCapabilitiesConfig {
  workspace_managed_sources_enabled: boolean;
  supported_network_routes: ['direct'];
}

export interface CatalogSourceListConfig {
  items: CatalogSourceConfig[];
  capabilities: CatalogSourceCapabilitiesConfig;
}

export interface CatalogArtifactConfig {
  id: string;
  workspace_id: string;
  source_id: string;
  binding_id: string;
  artifact_kind: 'mcp_server' | 'agent_skill';
  name: string;
  title?: string | null;
  description: string;
  version: string;
  digest: string;
  metadata: Record<string, unknown>;
  compatible: boolean;
  incompatibility_reason?: string | null;
  remote_endpoints: Array<{
    type: 'streamable-http';
    url: string;
    requiresConfiguration?: boolean;
    supportedCredentialModes?: Array<'none' | 'workspace' | 'individual'>;
    recommendedCredentialMode?: 'none' | 'workspace' | 'individual';
    headerNames?: string[];
    secretHeaderNames?: string[];
  }>;
  published_at?: string | null;
  upstream_updated_at?: string | null;
}

export interface CatalogArtifactPageConfig {
  items: CatalogArtifactConfig[];
  next_cursor?: string | null;
}

export interface CreateCatalogSourceInput {
  workspaceId: string;
  displayName: string;
  baseUrl: string;
  enabled?: boolean;
  networkRoute?: 'direct';
  auth?: {
    type: 'none' | 'bearer_token' | 'custom_header';
    secretName?: string;
    credential?: string;
    headerName?: string;
  };
}

export interface UpdateCatalogSourceInput {
  workspaceId: string;
  sourceId: string;
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  networkRoute?: 'direct';
  auth?: {
    type: 'none' | 'bearer_token' | 'custom_header';
    credential?: string;
    headerName?: string;
  };
}

interface ImportCatalogMcpServerBaseInput {
  workspaceId: string;
  artifact: { artifactId?: string; sourceId?: string; artifactName?: string };
  version: string;
  remoteEndpoint: string;
  serverName?: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  endpointConfiguration?: Record<string, string>;
  credentialMode?: 'none' | 'workspace' | 'individual';
  reimportServerId?: string;
  expectedRevision?: number;
}

export type ImportCatalogMcpServerInput = ImportCatalogMcpServerBaseInput & (
  | {
      scopeType: 'agent';
      agentId: string;
      targetConstraints?: { targetTypes?: TargetType[]; targetIds?: string[] };
    }
  | {
      scopeType: 'target';
      targetId: string;
      targetType: TargetType;
    }
);

export interface McpConnectionConfig {
  server_id: string;
  credential_mode: 'workspace' | 'individual';
  status: 'missing' | 'connected' | 'error';
  auth_type: 'bearer_token' | 'custom_header';
  action?: 'connect_mcp_server' | 'verify_mcp_server' | null;
  error_code?: string | null;
  verified_at?: string | null;
  updated_at?: string | null;
}

export interface UpsertMcpConnectionInput {
  workspaceId: string;
  serverId: string;
  ownerType: 'installation' | 'user';
  ownerId: string;
  credential: string;
  consentGranted: true;
}

export type McpReadinessFailureCode =
  | 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
  | 'MCP_CONNECTION_MISSING'
  | 'MCP_CONNECTION_ERROR'
  | 'MCP_CREDENTIAL_TOOL_UNAVAILABLE'
  | 'MCP_INSTALLATION_UNAVAILABLE'
  | 'MCP_REMOTE_DISABLED';

export interface McpReadinessResult {
  ready: boolean;
  failures: Array<{
    server_id: string;
    tool_name: string;
    code: McpReadinessFailureCode;
    action?: 'connect_mcp_server' | 'verify_mcp_server' | null;
  }>;
}

export async function listCatalogSources(workspaceId: string): Promise<CatalogSourceListConfig> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetchGateway(
    `/api/v1/internal/catalog/sources?${query.toString()}`,
    createGatewayRequestOptions('GET')
  );
  return parseGatewayResponse<CatalogSourceListConfig>(response);
}

export async function createCatalogSource(input: CreateCatalogSourceInput): Promise<CatalogSourceConfig> {
  const response = await fetchGateway(
    '/api/v1/internal/catalog/sources',
    createGatewayRequestOptions('POST', {
      workspace_id: input.workspaceId,
      display_name: input.displayName,
      base_url: input.baseUrl,
      enabled: input.enabled ?? true,
      network_route: input.networkRoute ?? 'direct',
      management_mode: 'workspace',
      artifact_kind: 'mcp_server',
      adapter_type: 'mcp_registry_v0_1',
      adapter_base_path: '/v0.1',
      auth_type: input.auth?.type ?? 'none',
      auth_secret_name: input.auth?.secretName,
      auth_secret_value: input.auth?.credential,
      auth_header_name: input.auth?.headerName
    })
  );
  return parseGatewayResponse<CatalogSourceConfig>(response);
}

export async function updateCatalogSource(input: UpdateCatalogSourceInput): Promise<CatalogSourceConfig> {
  const query = new URLSearchParams({ workspace_id: input.workspaceId });
  const auth = input.auth
    ? {
        type: input.auth.type,
        credential: input.auth.credential,
        header_name: input.auth.headerName
      }
    : undefined;
  const response = await fetchGateway(
    `/api/v1/internal/catalog/sources/${encodeURIComponent(input.sourceId)}?${query.toString()}`,
    createGatewayRequestOptions('PATCH', {
      display_name: input.displayName,
      base_url: input.baseUrl,
      enabled: input.enabled,
      network_route: input.networkRoute,
      auth
    })
  );
  return parseGatewayResponse<CatalogSourceConfig>(response);
}

export async function synchronizeCatalogSource(
  workspaceId: string,
  sourceId: string
): Promise<{ artifact_count: number }> {
  const query = new URLSearchParams({ workspace_id: workspaceId, full: 'true' });
  const response = await fetchGateway(
    `/api/v1/internal/catalog/sources/${encodeURIComponent(sourceId)}/sync?${query.toString()}`,
    createGatewayRequestOptions('POST')
  );
  return parseGatewayResponse<{ artifact_count: number }>(response);
}

export async function deleteCatalogSource(
  workspaceId: string,
  sourceId: string
): Promise<void> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetchGateway(
    `/api/v1/internal/catalog/sources/${encodeURIComponent(sourceId)}?${query.toString()}`,
    createGatewayRequestOptions('DELETE')
  );
  if (!response.ok) {
    const body = await response.text();
    throw new LlmGatewayHttpError(
      response.status,
      body || `llm-gateway catalog source delete failed (${response.status})`,
      body
    );
  }
}

export async function listCatalogArtifacts(
  workspaceId: string,
  options: {
    sourceId?: string;
    search?: string;
    compatible?: boolean;
    refresh?: boolean;
    limit?: number;
    offset?: number;
  } = {}
): Promise<CatalogArtifactPageConfig> {
  const query = new URLSearchParams({
    workspace_id: workspaceId,
    artifact_kind: 'mcp_server',
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0)
  });
  if (options.sourceId) query.set('source_id', options.sourceId);
  if (options.search) query.set('search', options.search);
  if (options.compatible !== undefined) query.set('compatible', String(options.compatible));
  if (options.refresh) query.set('refresh', 'true');
  const response = await fetchGateway(
    `/api/v1/internal/catalog/artifacts?${query.toString()}`,
    createGatewayRequestOptions('GET')
  );
  return parseGatewayResponse<CatalogArtifactPageConfig>(response);
}

export async function getCatalogArtifact(
  workspaceId: string,
  artifactId: string
): Promise<CatalogArtifactConfig> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetchGateway(
    `/api/v1/internal/catalog/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
    createGatewayRequestOptions('GET')
  );
  return parseGatewayResponse<CatalogArtifactConfig>(response);
}

export async function importCatalogMcpServer(
  input: ImportCatalogMcpServerInput
): Promise<McpServerConfig> {
  const destination = input.scopeType === 'target'
    ? {
        scope_type: 'target' as const,
        target_id: input.targetId,
        target_type: input.targetType
      }
    : {
        scope_type: 'agent' as const,
        agent_id: input.agentId,
        target_constraints: {
          target_types: input.targetConstraints?.targetTypes ?? [],
          target_ids: input.targetConstraints?.targetIds ?? []
        }
      };
  const response = await fetchGateway(
    '/api/v1/internal/catalog/imports',
    createGatewayRequestOptions('POST', {
      workspace_id: input.workspaceId,
      ...destination,
      artifact: {
        artifact_id: input.artifact.artifactId,
        source_id: input.artifact.sourceId,
        artifact_name: input.artifact.artifactName
      },
      version: input.version,
      remote_endpoint: input.remoteEndpoint,
      server_name: input.serverName,
      enabled: input.enabled ?? true,
      public_headers: input.publicHeaders,
      endpoint_configuration: input.endpointConfiguration ?? {},
      credential_mode: input.credentialMode,
      reimport_server_id: input.reimportServerId,
      expected_revision: input.expectedRevision
    })
  );
  return parseGatewayResponse<McpServerConfig>(response);
}

export async function getMcpConnection(
  workspaceId: string,
  serverId: string,
  ownerType: 'installation' | 'user',
  ownerId: string
): Promise<McpConnectionConfig> {
  const query = new URLSearchParams({ workspace_id: workspaceId, owner_type: ownerType });
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/connections/${encodeURIComponent(ownerId)}?${query.toString()}`,
    createGatewayRequestOptions('GET')
  );
  return parseGatewayResponse<McpConnectionConfig>(response);
}

export async function upsertMcpConnection(
  input: UpsertMcpConnectionInput
): Promise<McpConnectionConfig> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(input.serverId)}/connections/${encodeURIComponent(input.ownerId)}`,
    createGatewayRequestOptions('PUT', {
      workspace_id: input.workspaceId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      credential: input.credential,
      consent_granted: input.consentGranted
    })
  );
  return parseGatewayResponse<McpConnectionConfig>(response);
}

export async function deleteMcpConnection(
  workspaceId: string,
  serverId: string,
  ownerType: 'installation' | 'user',
  ownerId: string
): Promise<void> {
  const query = new URLSearchParams({ workspace_id: workspaceId, owner_type: ownerType });
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/connections/${encodeURIComponent(ownerId)}?${query.toString()}`,
    createGatewayRequestOptions('DELETE')
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new LlmGatewayHttpError(
      response.status,
      body || `llm-gateway disconnect failed (${response.status})`,
      body
    );
  }
}

export async function verifyMcpConnection(
  workspaceId: string,
  serverId: string,
  ownerType: 'installation' | 'user',
  ownerId: string
): Promise<McpConnectionConfig> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/connections/${encodeURIComponent(ownerId)}/verify`,
    createGatewayRequestOptions('POST', {
      workspace_id: workspaceId,
      owner_type: ownerType,
      owner_id: ownerId
    })
  );
  return parseGatewayResponse<McpConnectionConfig>(response);
}

export async function checkMcpReadiness(input: {
  workspaceId: string;
  principal: { type: 'user' | 'service_identity'; id: string };
  toolRefs: Array<{ serverId: string; toolName: string }>;
}): Promise<McpReadinessResult> {
  const response = await fetchGateway(
    '/api/v1/internal/mcp/connections/readiness',
    createGatewayRequestOptions('POST', {
      workspace_id: input.workspaceId,
      principal: input.principal,
      tool_refs: input.toolRefs.map((ref) => ({
        server_id: ref.serverId,
        tool_name: ref.toolName
      }))
    })
  );
  return parseGatewayResponse<McpReadinessResult>(response);
}

export async function cleanupMcpConnections(
  workspaceId: string,
  userId?: string
): Promise<void> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (userId) query.set('user_id', userId);
  const response = await fetchGateway(
    `/api/v1/internal/mcp/connections?${query.toString()}`,
    createGatewayRequestOptions('DELETE')
  );
  if (!response.ok) {
    const body = await response.text();
    throw new LlmGatewayHttpError(
      response.status,
      body || `llm-gateway MCP cleanup failed (${response.status})`,
      body,
      response.headers.get('retry-after') || undefined
    );
  }
}
