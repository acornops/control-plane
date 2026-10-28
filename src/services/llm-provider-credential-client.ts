import type { InternalHttpResponse } from './internal-http-client.js';
import {
  createGatewayRequestOptions as createRequestOptions,
  fetchGateway,
  LlmGatewayHttpError
} from './llm-gateway-admin-client.js';
import { LlmProvider } from '../types/domain.js';

export interface ProviderCredentialStatus {
  provider: LlmProvider;
  configured: boolean;
  enabled: boolean;
  source: 'workspace' | 'platform_default' | 'none';
}

export interface ProviderCredentialStatusResponse {
  workspace_id: string;
  providers: ProviderCredentialStatus[];
}

export interface ProviderDefaultCredentialStatusResponse {
  providers: ProviderCredentialStatus[];
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

export async function listDefaultProviderCredentials(): Promise<ProviderDefaultCredentialStatusResponse> {
  const response = await fetchGateway(
    '/api/v1/internal/llm/default-provider-credentials',
    createRequestOptions('GET')
  );
  return parseOrThrow<ProviderDefaultCredentialStatusResponse>(response);
}

export async function putDefaultProviderCredential(
  provider: LlmProvider,
  apiKey: string
): Promise<ProviderCredentialStatus> {
  const response = await fetchGateway(
    `/api/v1/internal/llm/default-provider-credentials/${encodeURIComponent(provider)}`,
    createRequestOptions('PUT', { api_key: apiKey })
  );
  return parseOrThrow<ProviderCredentialStatus>(response);
}

export async function deleteDefaultProviderCredential(
  provider: LlmProvider
): Promise<ProviderCredentialStatus> {
  const response = await fetchGateway(
    `/api/v1/internal/llm/default-provider-credentials/${encodeURIComponent(provider)}`,
    createRequestOptions('DELETE')
  );
  return parseOrThrow<ProviderCredentialStatus>(response);
}
