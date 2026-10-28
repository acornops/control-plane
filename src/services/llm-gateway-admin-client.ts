import { setTimeout as delay } from 'node:timers/promises';
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

function isGatewayDraining(body: string): boolean {
  try {
    const error = JSON.parse(body)?.error;
    return error?.code === 'SERVICE_DRAINING' && error.message === 'Service is draining'
      && error.retryable === true && error.outcome === 'not_started';
  } catch {
    return false;
  }
}

export async function fetchGateway(path: string, options: RequestInit): Promise<InternalHttpResponse> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = controller.signal;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = performance.now() + config.LLM_GATEWAY_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), config.LLM_GATEWAY_TIMEOUT_MS);
  let lastDrainResponse: InternalHttpResponse | undefined;
  let rejectOnAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  const request = async (): Promise<InternalHttpResponse> => {
    while (true) {
      signal.throwIfAborted();
      const response = await internalFetch(`${config.LLM_GATEWAY_URL}${path}`, {
        ...options, redirect: 'error', signal
      }, Math.max(1, deadline - performance.now()));
      // These admin endpoints return finite JSON. Buffer under the same deadline;
      // the internal TLS response has no clone and its body can be consumed once.
      const body = await response.text();
      signal.throwIfAborted();
      const buffered = new Response(response.body === null ? null : body, {
        status: response.status, headers: response.headers
      });
      if ((options.method || 'GET').toUpperCase() !== 'GET'
        || response.status !== 503 || !isGatewayDraining(body)) return buffered;
      lastDrainResponse = buffered;
      await delay(250, undefined, { signal });
    }
  };
  try {
    return await Promise.race([request(), aborted]);
  } catch (error) {
    // Exhausted drain retries retain the existing HTTP error mapping. Caller
    // cancellation and ordinary transport failures still propagate unchanged.
    if (controller.signal.aborted && !options.signal?.aborted && lastDrainResponse) return lastDrainResponse;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
    signal.removeEventListener('abort', rejectOnAbort);
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
