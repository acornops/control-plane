import { config } from '../config.js';
import { internalFetch, type InternalHttpResponse } from './internal-http-client.js';
import { LlmGatewayHttpError } from './mcp-registry-client.js';
import { LlmProvider } from '../types/domain.js';

export interface ProviderCredentialStatus {
  provider: LlmProvider;
  configured: boolean;
  enabled: boolean;
}

export interface ProviderCredentialStatusResponse {
  workspace_id: string;
  providers: ProviderCredentialStatus[];
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

export async function listWorkspaceProviderCredentials(workspaceId: string): Promise<ProviderCredentialStatusResponse> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetchGateway(
    `/api/v1/internal/llm/provider-credentials?${query.toString()}`,
    createRequestOptions('GET')
  );
  return parseOrThrow<ProviderCredentialStatusResponse>(response);
}

export async function putWorkspaceProviderCredential(
  workspaceId: string,
  provider: LlmProvider,
  apiKey: string
): Promise<ProviderCredentialStatus> {
  const response = await fetchGateway(
    `/api/v1/internal/llm/provider-credentials/${encodeURIComponent(provider)}`,
    createRequestOptions('PUT', { workspace_id: workspaceId, api_key: apiKey })
  );
  return parseOrThrow<ProviderCredentialStatus>(response);
}

export async function deleteWorkspaceProviderCredential(
  workspaceId: string,
  provider: LlmProvider
): Promise<ProviderCredentialStatus> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  const response = await fetchGateway(
    `/api/v1/internal/llm/provider-credentials/${encodeURIComponent(provider)}?${query.toString()}`,
    createRequestOptions('DELETE')
  );
  return parseOrThrow<ProviderCredentialStatus>(response);
}
