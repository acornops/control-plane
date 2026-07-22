import { config } from '../config.js';
import { internalFetch, type InternalHttpResponse } from './internal-http-client.js';

export class LlmGatewayHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly retryAfter?: string;

  constructor(status: number, message: string, responseBody: string, retryAfter?: string) {
    super(message);
    this.name = 'LlmGatewayHttpError';
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
  }
}

export function createGatewayRequestOptions(method: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.LLM_GATEWAY_ADMIN_TOKEN}`
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  };
}

export async function fetchGateway(path: string, options: RequestInit): Promise<InternalHttpResponse> {
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

export async function parseGatewayResponse<T>(response: InternalHttpResponse): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      if (typeof parsed.detail === 'string' && parsed.detail.length > 0) message = parsed.detail;
    } catch {
      // keep raw body fallback
    }
    throw new LlmGatewayHttpError(
      response.status,
      message || `llm-gateway request failed (${response.status})`,
      body,
      response.headers.get('retry-after') || undefined
    );
  }
  return (await response.json()) as T;
}
