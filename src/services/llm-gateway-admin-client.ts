import { config } from '../config.js';
import { internalFetch, type InternalHttpResponse } from './internal-http-client.js';

export class LlmGatewayHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly retryAfter?: string;
  readonly gatewayCode?: string;

  constructor(status: number, message: string, responseBody: string, retryAfter?: string, gatewayCode?: string) {
    super(message);
    this.name = 'LlmGatewayHttpError';
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
    this.gatewayCode = gatewayCode;
  }
}

function gatewayErrorFields(body: string): { message?: string; code?: string } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail = parsed.detail;
    const error = parsed.error;
    const detailRecord = detail && typeof detail === 'object' && !Array.isArray(detail)
      ? detail as Record<string, unknown>
      : undefined;
    const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
      ? error as Record<string, unknown>
      : undefined;
    const message = [
      typeof detail === 'string' ? detail : undefined,
      typeof detailRecord?.message === 'string' ? detailRecord.message : undefined,
      typeof errorRecord?.message === 'string' ? errorRecord.message : undefined,
      typeof parsed.message === 'string' ? parsed.message : undefined
    ].find((value): value is string => Boolean(value));
    const code = [
      typeof detailRecord?.code === 'string' ? detailRecord.code : undefined,
      typeof errorRecord?.code === 'string' ? errorRecord.code : undefined,
      typeof parsed.code === 'string' ? parsed.code : undefined
    ].find((value): value is string => Boolean(value));
    return { message, code };
  } catch {
    return {};
  }
}

export function isMcpLifecycleFencedError(error: unknown): error is LlmGatewayHttpError {
  return error instanceof LlmGatewayHttpError
    && error.status === 409
    && error.gatewayCode === 'MCP_LIFECYCLE_FENCED';
}

export function createMcpLifecycleFencedError(): LlmGatewayHttpError {
  const detail = {
    code: 'MCP_LIFECYCLE_FENCED',
    message: 'MCP lifecycle teardown is in progress for this destination.',
    retryable: false
  };
  return new LlmGatewayHttpError(
    409,
    detail.message,
    JSON.stringify({ detail }),
    undefined,
    detail.code
  );
}

export function createMcpUserLifecycleStaleError(message = 'MCP user lifecycle generation is not active.'): LlmGatewayHttpError {
  const detail = {
    code: 'MCP_USER_LIFECYCLE_STALE',
    message,
    retryable: false
  };
  return new LlmGatewayHttpError(
    409,
    detail.message,
    JSON.stringify({ detail }),
    undefined,
    detail.code
  );
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
    const fields = gatewayErrorFields(body);
    throw new LlmGatewayHttpError(
      response.status,
      fields.message || body || `llm-gateway request failed (${response.status})`,
      body,
      response.headers.get('retry-after') || undefined,
      fields.code
    );
  }
  return (await response.json()) as T;
}
