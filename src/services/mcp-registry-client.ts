import { logger } from '../logger.js';
import { TargetType } from '../types/domain.js';
import {
  createGatewayRequestOptions as createRequestOptions,
  fetchGateway,
  LlmGatewayHttpError,
  parseGatewayResponse as parseOrThrow
} from './llm-gateway-admin-client.js';
export { LlmGatewayHttpError } from './llm-gateway-admin-client.js';
export * from './mcp-catalog-client.js';
export interface McpToolConfig {
  name: string;
  server_id: string;
  model_alias: string;
  mcp_server_url: string;
  timeout_ms: number;
  description?: string;
  capability?: 'read' | 'write';
  version?: string;
  source?: 'mcp' | 'builtin';
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  artifact_policy?: 'never' | 'if_detailed' | 'always';
  enabled: boolean;
  review_state?: 'pending' | 'approved' | 'rejected';
  risk_level?: 'read_only' | 'non_destructive_write' | 'high_risk' | 'destructive';
  auto_allowed?: boolean;
}
export interface McpServerConfig {
  id: string;
  workspace_id: string;
  target_id?: string | null;
  agent_id?: string | null;
  scope_type?: 'agent' | 'target';
  target_type?: TargetType | 'agent' | null;
  target_constraints?: { target_types?: TargetType[]; target_ids?: string[] };
  server_name: string;
  server_url: string;
  enabled: boolean;
  auth_type: 'none' | 'bearer_token' | 'custom_header';
  auth_scope?: 'none' | 'personal';
  credential_configured?: boolean;
  auth_header_name?: string;
  auth_header_prefix?: string;
  public_headers?: Record<string, string> | null;
  connection_status?: 'unknown' | 'ok' | 'error';
  last_discovery_at?: string | null;
  last_discovery_error?: string | null;
  catalog_source_id?: string | null;
  catalog_artifact_name?: string | null;
  catalog_version?: string | null;
  catalog_digest?: string | null;
  catalog_imported_at?: string | null;
  tools: McpToolConfig[];
  provenance_type?: 'manual' | 'catalog' | 'builtin';
  endpoint_configuration?: Record<string, unknown>;
  integration_profile_id?: string | null;
  integration_profile_version?: number | null;
  revision?: number;
}

export type PublicMcpServerConfig = Omit<McpServerConfig, 'credential_configured'>;

export function toPublicMcpServerConfig(server: McpServerConfig): PublicMcpServerConfig {
  const publicServer = { ...server };
  delete publicServer.credential_configured;
  return publicServer;
}

export interface McpServerConnectionTestResult {
  server_id: string;
  server_name: string;
  server_url: string;
  connection_status: 'ok' | 'error';
  last_discovery_at: string;
  discovered_tool_count: number;
  discovered_tools: string[];
  error?: string | null;
}
export interface UpsertTargetMcpServerInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  name: string;
  url: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  auth?: {
    type?: 'none' | 'bearer_token' | 'custom_header';
    headerName?: string;
    headerPrefix?: string;
  };
  tools?: Array<{
    name: string;
    timeoutMs?: number;
    description?: string;
    capability?: 'read' | 'write';
    version?: string;
    source?: 'mcp' | 'builtin';
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    artifactPolicy?: 'never' | 'if_detailed' | 'always';
    enabled?: boolean;
  }>;
}
export interface UpdateTargetMcpServerInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  serverId: string;
  url?: string;
  name?: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  auth?: {
    type?: 'none' | 'bearer_token' | 'custom_header';
    headerName?: string;
    headerPrefix?: string;
  };
  tools?: Array<{
    name: string;
    timeoutMs?: number;
    description?: string;
    capability?: 'read' | 'write';
    version?: string;
    source?: 'mcp' | 'builtin';
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    artifactPolicy?: 'never' | 'if_detailed' | 'always';
    enabled?: boolean;
  }>;
  removeTools?: string[];
}

function gatewayTargetQuery(workspaceId: string, targetId: string, targetType: TargetType): string {
  return new URLSearchParams({
    workspace_id: workspaceId,
    target_id: targetId,
    target_type: targetType
  }).toString();
}

function gatewayAgentQuery(workspaceId: string, agentId: string): string {
  return new URLSearchParams({
    workspace_id: workspaceId,
    scope_type: 'agent',
    agent_id: agentId,
    target_id: agentId,
    target_type: 'agent'
  }).toString();
}

function toGatewayToolPayload(tool: {
  name: string;
  timeoutMs?: number;
  description?: string;
  capability?: 'read' | 'write';
  version?: string;
  source?: 'mcp' | 'builtin';
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  artifactPolicy?: 'never' | 'if_detailed' | 'always';
  enabled?: boolean;
}) {
  return {
    name: tool.name,
    timeout_ms: tool.timeoutMs ?? 10000,
    description: tool.description,
    capability: tool.capability,
    version: tool.version,
    source: tool.source,
    input_schema: tool.inputSchema,
    output_schema: tool.outputSchema,
    artifact_policy: tool.artifactPolicy,
    enabled: tool.enabled ?? true
  };
}

export async function listTargetMcpServers(
  workspaceId: string,
  targetId: string,
  targetType: TargetType
): Promise<McpServerConfig[]> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers?${gatewayTargetQuery(workspaceId, targetId, targetType)}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpServerConfig[]>(response);
}

export async function listTargetMcpTools(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  options?: {
    includeServerDisabled?: boolean;
    includeDisabled?: boolean;
  }
): Promise<McpToolConfig[]> {
  const query = new URLSearchParams({
    workspace_id: workspaceId,
    target_id: targetId,
    target_type: targetType
  });
  if (options?.includeServerDisabled) {
    query.set('include_server_disabled', 'true');
  }
  if (options?.includeDisabled) {
    query.set('include_disabled', 'true');
  }
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools?${query.toString()}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpToolConfig[]>(response);
}

export async function createTargetMcpServer(input: UpsertTargetMcpServerInput): Promise<McpServerConfig> {
  const body = {
    workspace_id: input.workspaceId,
    target_id: input.targetId,
    target_type: input.targetType,
    server_name: input.name,
    server_url: input.url,
    enabled: input.enabled ?? true,
    public_headers: input.publicHeaders,
    auth_type: input.auth?.type ?? 'none',
    auth_scope: input.auth?.type && input.auth.type !== 'none' ? 'personal' : 'none',
    auth_header_name: input.auth?.headerName,
    auth_header_prefix: input.auth?.headerPrefix,
    tools: (input.tools || []).map(toGatewayToolPayload)
  };

  const response = await fetchGateway('/api/v1/internal/mcp/servers', createRequestOptions('POST', body));
  return parseOrThrow<McpServerConfig>(response);
}

export async function updateTargetMcpServer(input: UpdateTargetMcpServerInput): Promise<McpServerConfig> {
  const body = {
    server_name: input.name,
    server_url: input.url,
    enabled: input.enabled,
    public_headers: input.publicHeaders,
    auth_type: input.auth?.type,
    auth_header_name: input.auth?.headerName,
    auth_header_prefix: input.auth?.headerPrefix,
    tools: input.tools?.map(toGatewayToolPayload),
    remove_tools: input.removeTools || []
  };
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(input.serverId)}?${gatewayTargetQuery(input.workspaceId, input.targetId, input.targetType)}`,
    createRequestOptions('PATCH', body)
  );
  return parseOrThrow<McpServerConfig>(response);
}

export async function deleteTargetMcpServer(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  serverId: string
): Promise<void> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}?${gatewayTargetQuery(workspaceId, targetId, targetType)}`,
    createRequestOptions('DELETE')
  );

  if (!response.ok) {
    const body = await response.text();
    logger.error({ status: response.status }, 'Failed deleting MCP server');
    throw new LlmGatewayHttpError(response.status, body || `llm-gateway delete failed (${response.status})`, body);
  }
}

export async function testTargetMcpServerConnection(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  serverId: string
): Promise<McpServerConnectionTestResult> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/test?${gatewayTargetQuery(workspaceId, targetId, targetType)}`,
    createRequestOptions('POST')
  );
  return parseOrThrow<McpServerConnectionTestResult>(response);
}

export async function updateTargetTool(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  serverId: string,
  toolName: string,
  patch: {
    enabled?: boolean;
    timeoutMs?: number;
    description?: string;
    capability?: 'read' | 'write';
    version?: string;
    inputSchema?: Record<string, unknown>;
  }
): Promise<McpToolConfig> {
  const body = {
    enabled: patch.enabled,
    timeout_ms: patch.timeoutMs,
    description: patch.description,
    capability: patch.capability,
    version: patch.version,
    input_schema: patch.inputSchema
  };
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}?${gatewayTargetQuery(workspaceId, targetId, targetType)}&server_id=${encodeURIComponent(serverId)}`,
    createRequestOptions('PATCH', body)
  );
  return parseOrThrow<McpToolConfig>(response);
}

export interface UpsertAgentMcpServerInput extends Omit<UpsertTargetMcpServerInput, 'targetId' | 'targetType'> {
  agentId: string;
  authScope?: 'none' | 'personal';
  targetConstraints?: { targetTypes?: TargetType[]; targetIds?: string[] };
  integrationProfileId?: string;
  integrationProfileVersion?: number;
  configurationAttested?: boolean;
}

export interface UpdateAgentMcpServerInput extends Omit<UpdateTargetMcpServerInput, 'targetId' | 'targetType'> {
  agentId: string;
  expectedRevision?: number;
  targetConstraints?: { targetTypes?: TargetType[]; targetIds?: string[] };
}

export async function listAgentMcpServers(workspaceId: string, agentId: string): Promise<McpServerConfig[]> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers?${gatewayAgentQuery(workspaceId, agentId)}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpServerConfig[]>(response);
}

export async function listAgentMcpTools(
  workspaceId: string,
  agentId: string,
  options?: { includeServerDisabled?: boolean; includeDisabled?: boolean }
): Promise<McpToolConfig[]> {
  const query = new URLSearchParams(gatewayAgentQuery(workspaceId, agentId));
  if (options?.includeServerDisabled) query.set('include_server_disabled', 'true');
  if (options?.includeDisabled) query.set('include_disabled', 'true');
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools?${query.toString()}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpToolConfig[]>(response);
}

export async function createAgentMcpServer(input: UpsertAgentMcpServerInput): Promise<McpServerConfig> {
  const response = await fetchGateway('/api/v1/internal/mcp/servers', createRequestOptions('POST', {
    workspace_id: input.workspaceId,
    scope_type: 'agent',
    agent_id: input.agentId,
    target_constraints: {
      target_types: input.targetConstraints?.targetTypes ?? [],
      target_ids: input.targetConstraints?.targetIds ?? []
    },
    server_name: input.name,
    server_url: input.url,
    enabled: input.enabled ?? true,
    public_headers: input.publicHeaders,
    auth_type: input.auth?.type ?? 'none',
    auth_scope: input.auth?.type && input.auth.type !== 'none'
      ? 'personal'
      : input.authScope ?? 'none',
    auth_header_name: input.auth?.headerName,
    auth_header_prefix: input.auth?.headerPrefix,
    integration_profile_id: input.integrationProfileId,
    integration_profile_version: input.integrationProfileVersion,
    configuration_attested: input.configurationAttested ?? false,
    tools: []
  }));
  return parseOrThrow<McpServerConfig>(response);
}

export async function updateAgentMcpServer(input: UpdateAgentMcpServerInput): Promise<McpServerConfig> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(input.serverId)}?${gatewayAgentQuery(input.workspaceId, input.agentId)}`,
    createRequestOptions('PATCH', {
      server_name: input.name,
      enabled: input.enabled,
      public_headers: input.publicHeaders,
      auth_type: input.auth?.type,
      auth_header_name: input.auth?.headerName,
      auth_header_prefix: input.auth?.headerPrefix,
      expected_revision: input.expectedRevision,
      target_constraints: input.targetConstraints ? {
        target_types: input.targetConstraints.targetTypes ?? [],
        target_ids: input.targetConstraints.targetIds ?? []
      } : undefined,
      remove_tools: input.removeTools || []
    })
  );
  return parseOrThrow<McpServerConfig>(response);
}

export async function deleteAgentMcpServer(workspaceId: string, agentId: string, serverId: string): Promise<void> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}?${gatewayAgentQuery(workspaceId, agentId)}`,
    createRequestOptions('DELETE')
  );
  if (!response.ok) {
    const body = await response.text();
    throw new LlmGatewayHttpError(response.status, body || `llm-gateway delete failed (${response.status})`, body);
  }
}

export async function testAgentMcpServerConnection(
  workspaceId: string,
  agentId: string,
  serverId: string
): Promise<McpServerConnectionTestResult> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/test?${gatewayAgentQuery(workspaceId, agentId)}`,
    createRequestOptions('POST')
  );
  return parseOrThrow<McpServerConnectionTestResult>(response);
}

export async function updateAgentMcpTool(
  workspaceId: string,
  agentId: string,
  serverId: string,
  toolName: string,
  patch: {
    enabled?: boolean;
    capability?: 'read' | 'write';
    reviewState?: 'pending' | 'approved' | 'rejected';
    riskLevel?: 'read_only' | 'non_destructive_write' | 'high_risk' | 'destructive';
    autoAllowed?: boolean;
  }
): Promise<McpToolConfig> {
  const query = `${gatewayAgentQuery(workspaceId, agentId)}&server_id=${encodeURIComponent(serverId)}`;
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}?${query}`,
    createRequestOptions('PATCH', {
      enabled: patch.enabled,
      capability: patch.capability,
      review_state: patch.reviewState,
      risk_level: patch.riskLevel,
      auto_allowed: patch.autoAllowed
    })
  );
  return parseOrThrow<McpToolConfig>(response);
}
