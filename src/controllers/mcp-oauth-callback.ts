import { config } from '../config.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';

const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const MCP_VERIFICATION_CALLBACK_CODES = new Set([
  'MCP_AUTHENTICATION_REJECTED',
  'MCP_DISCOVERY_INVALID_RESPONSE',
  'MCP_DISCOVERY_RESPONSE_TOO_LARGE',
  'MCP_DISCOVERY_TIMEOUT',
  'MCP_EGRESS_BLOCKED',
  'MCP_ENDPOINT_NOT_FOUND',
  'MCP_ENDPOINT_UNAVAILABLE',
  'MCP_PROTOCOL_ERROR',
  'MCP_TOOL_DISCOVERY_FAILED'
]);

export function safeReturnPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 2048
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

export function queryValue(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function safeMcpServerId(value: unknown): string | undefined {
  return typeof value === 'string' && MCP_SERVER_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export type CallbackErrorDetails = {
  code: string;
  returnPath?: string;
  workspaceId?: string;
  serverId?: string;
};

function safeCallbackErrorCode(value: unknown): string {
  if (typeof value !== 'string') return 'MCP_OAUTH_CALLBACK_FAILED';
  if (/^MCP_OAUTH_[A-Z0-9_]+$/.test(value)) return value;
  return MCP_VERIFICATION_CALLBACK_CODES.has(value)
    ? value
    : 'MCP_OAUTH_CALLBACK_FAILED';
}

export function callbackErrorDetails(error: unknown): CallbackErrorDetails {
  if (!(error instanceof LlmGatewayHttpError)) {
    return { code: 'MCP_OAUTH_CALLBACK_FAILED' };
  }
  try {
    const parsed = JSON.parse(error.responseBody) as {
      detail?: {
        code?: unknown;
        return_path?: unknown;
        workspace_id?: unknown;
        server_id?: unknown;
      };
    };
    const serverId = safeMcpServerId(parsed.detail?.server_id);
    return {
      code: safeCallbackErrorCode(parsed.detail?.code),
      ...(safeReturnPath(parsed.detail?.return_path)
        ? { returnPath: parsed.detail.return_path }
        : {}),
      ...(typeof parsed.detail?.workspace_id === 'string'
        ? { workspaceId: parsed.detail.workspace_id }
        : {}),
      ...(serverId ? { serverId } : {})
    };
  } catch {
    return { code: 'MCP_OAUTH_CALLBACK_FAILED' };
  }
}

export function consoleRedirectUrl(
  returnPath: string,
  result: string,
  serverId?: string
): string {
  const consoleOrigin = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
  const target = new URL(returnPath, consoleOrigin);
  if (target.origin !== consoleOrigin.origin) {
    throw new Error('Unsafe MCP OAuth return path');
  }
  target.searchParams.set('mcpOAuthResult', result);
  const validatedServerId = safeMcpServerId(serverId);
  if (validatedServerId) target.searchParams.set('mcpOAuthServerId', validatedServerId);
  return target.toString();
}
