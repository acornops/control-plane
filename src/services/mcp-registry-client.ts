import { config } from '../config.js';
import { logger } from '../logger.js';
import { TargetType } from '../types/domain.js';
import { internalFetch, type InternalHttpResponse } from './internal-http-client.js';

export interface McpToolConfig {
  name: string;
  mcp_server_url: string;
  timeout_ms: number;
  description?: string;
  capability?: 'read' | 'write';
  version?: string;
  source?: 'mcp' | 'builtin';
  input_schema?: Record<string, unknown>;
  enabled: boolean;
}

export interface McpServerConfig {
  id: string;
  workspace_id: string;
  target_id: string;
  scope_type?: 'workspace' | 'target';
  target_type: TargetType | 'workspace';
  server_name: string;
  server_url: string;
  enabled: boolean;
  auth_type: 'none' | 'bearer_token' | 'custom_header';
  credential_configured?: boolean;
  auth_header_name?: string;
  auth_header_prefix?: string;
  public_headers?: Record<string, string> | null;
  connection_status?: 'unknown' | 'ok' | 'error';
  last_discovery_at?: string | null;
  last_discovery_error?: string | null;
  tools: McpToolConfig[];
}

export type UpsertWorkspaceMcpServerInput = Omit<UpsertTargetMcpServerInput, 'targetId' | 'targetType'>;
export type UpdateWorkspaceMcpServerInput = Omit<UpdateTargetMcpServerInput, 'targetId' | 'targetType'>;

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
    secretName?: string;
    secretValue?: string;
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
    enabled?: boolean;
  }>;
}

export interface UpdateTargetMcpServerInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  serverId: string;
  name?: string;
  enabled?: boolean;
  publicHeaders?: Record<string, string>;
  auth?: {
    type?: 'none' | 'bearer_token' | 'custom_header';
    secretName?: string;
    secretValue?: string;
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
    enabled?: boolean;
  }>;
  removeTools?: string[];
}

export class LlmGatewayHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody: string) {
    super(message);
    this.name = 'LlmGatewayHttpError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

function createRequestOptions(method: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.LLM_GATEWAY_ADMIN_TOKEN}`
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  };
}

async function fetchGateway(path: string, options: RequestInit): Promise<InternalHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.LLM_GATEWAY_TIMEOUT_MS);
  try {
    return await internalFetch(`${config.LLM_GATEWAY_URL}${path}`, {
      ...options,
      signal: controller.signal
    }, config.LLM_GATEWAY_TIMEOUT_MS);
  } finally {
    clearTimeout(timeout);
  }
}

function gatewayTargetQuery(workspaceId: string, targetId: string, targetType: TargetType): string {
  return new URLSearchParams({
    workspace_id: workspaceId,
    target_id: targetId,
    target_type: targetType
  }).toString();
}

function gatewayWorkspaceQuery(workspaceId: string): string {
  return new URLSearchParams({
    workspace_id: workspaceId,
    scope_type: 'workspace',
    target_id: '__workspace__',
    target_type: 'workspace'
  }).toString();
}

async function parseOrThrow<T>(response: InternalHttpResponse): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
        message = parsed.detail;
      }
    } catch {
      // keep raw body fallback
    }
    throw new LlmGatewayHttpError(response.status, message || `llm-gateway request failed (${response.status})`, body);
  }
  return (await response.json()) as T;
}

function toGatewayToolPayload(tool: {
  name: string;
  timeoutMs?: number;
  description?: string;
  capability?: 'read' | 'write';
  version?: string;
  source?: 'mcp' | 'builtin';
  inputSchema?: Record<string, unknown>;
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
    auth_secret_name: input.auth?.secretName,
    auth_secret_value: input.auth?.secretValue,
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
    enabled: input.enabled,
    public_headers: input.publicHeaders,
    auth_type: input.auth?.type,
    auth_secret_name: input.auth?.secretName,
    auth_secret_value: input.auth?.secretValue,
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
    logger.error({ status: response.status, body }, 'Failed deleting MCP server');
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
    `/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}?${gatewayTargetQuery(workspaceId, targetId, targetType)}`,
    createRequestOptions('PATCH', body)
  );
  return parseOrThrow<McpToolConfig>(response);
}

export async function listWorkspaceMcpServers(workspaceId: string): Promise<McpServerConfig[]> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers?${gatewayWorkspaceQuery(workspaceId)}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpServerConfig[]>(response);
}

export async function listWorkspaceMcpTools(
  workspaceId: string,
  options?: { includeServerDisabled?: boolean; includeDisabled?: boolean }
): Promise<McpToolConfig[]> {
  const query = new URLSearchParams(gatewayWorkspaceQuery(workspaceId));
  if (options?.includeServerDisabled) query.set('include_server_disabled', 'true');
  if (options?.includeDisabled) query.set('include_disabled', 'true');
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools?${query.toString()}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<McpToolConfig[]>(response);
}

export async function createWorkspaceMcpServer(input: UpsertWorkspaceMcpServerInput): Promise<McpServerConfig> {
  const response = await fetchGateway('/api/v1/internal/mcp/servers', createRequestOptions('POST', {
    workspace_id: input.workspaceId,
    scope_type: 'workspace',
    target_id: '__workspace__',
    target_type: 'workspace',
    server_name: input.name,
    server_url: input.url,
    enabled: input.enabled ?? true,
    public_headers: input.publicHeaders,
    auth_type: input.auth?.type ?? 'none',
    auth_secret_name: input.auth?.secretName,
    auth_secret_value: input.auth?.secretValue,
    auth_header_name: input.auth?.headerName,
    auth_header_prefix: input.auth?.headerPrefix,
    tools: (input.tools || []).map(toGatewayToolPayload)
  }));
  return parseOrThrow<McpServerConfig>(response);
}

export async function updateWorkspaceMcpServer(input: UpdateWorkspaceMcpServerInput): Promise<McpServerConfig> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(input.serverId)}?${gatewayWorkspaceQuery(input.workspaceId)}`,
    createRequestOptions('PATCH', {
      server_name: input.name,
      enabled: input.enabled,
      public_headers: input.publicHeaders,
      auth_type: input.auth?.type,
      auth_secret_name: input.auth?.secretName,
      auth_secret_value: input.auth?.secretValue,
      auth_header_name: input.auth?.headerName,
      auth_header_prefix: input.auth?.headerPrefix,
      tools: input.tools?.map(toGatewayToolPayload),
      remove_tools: input.removeTools || []
    })
  );
  return parseOrThrow<McpServerConfig>(response);
}

export async function deleteWorkspaceMcpServer(workspaceId: string, serverId: string): Promise<void> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}?${gatewayWorkspaceQuery(workspaceId)}`,
    createRequestOptions('DELETE')
  );
  if (!response.ok) {
    const body = await response.text();
    throw new LlmGatewayHttpError(response.status, body || `llm-gateway delete failed (${response.status})`, body);
  }
}

export async function testWorkspaceMcpServerConnection(
  workspaceId: string,
  serverId: string
): Promise<McpServerConnectionTestResult> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/servers/${encodeURIComponent(serverId)}/test?${gatewayWorkspaceQuery(workspaceId)}`,
    createRequestOptions('POST')
  );
  return parseOrThrow<McpServerConnectionTestResult>(response);
}

export async function updateWorkspaceTool(
  workspaceId: string,
  toolName: string,
  patch: { enabled?: boolean; capability?: 'read' | 'write' }
): Promise<McpToolConfig> {
  const response = await fetchGateway(
    `/api/v1/internal/mcp/tools/${encodeURIComponent(toolName)}?${gatewayWorkspaceQuery(workspaceId)}`,
    createRequestOptions('PATCH', patch)
  );
  return parseOrThrow<McpToolConfig>(response);
}
