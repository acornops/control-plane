export type McpAuthType = 'none' | 'bearer_token' | 'custom_header' | 'oauth';
export type McpCredentialMode = 'none' | 'workspace' | 'individual';

const MCP_AUTH_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MCP_AUTH_HEADER_NAME_LIMIT = 128;
const MCP_AUTH_HEADER_PREFIX_LIMIT = 4096;
const RESERVED_MCP_AUTH_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'proxy-connection',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'x-workspace-id',
  'x-target-id',
  'x-target-type',
  'x-run-id',
  'x-tool-name',
  'accept',
  'accept-encoding',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id'
]);

export interface CurrentMcpAuthConfig {
  authType: McpAuthType;
  credentialMode: McpCredentialMode;
  headerName?: string | null;
  headerPrefix?: string | null;
  publicHeaders?: Record<string, string> | null;
}

export interface McpAuthConfigPatch {
  authType?: McpAuthType;
  credentialMode?: McpCredentialMode;
  headerName?: string;
  headerPrefix?: string;
  publicHeaders?: Record<string, string>;
}

export interface EffectiveMcpAuthConfig {
  authType: McpAuthType;
  credentialMode: McpCredentialMode;
  headerName?: string;
  headerPrefix?: string;
}

export function validateMcpAuthHeaderName(name: string): string | null {
  if (name !== name.trim() || name.length === 0) {
    return 'Auth header name must not be empty or padded.';
  }
  if (name.length > MCP_AUTH_HEADER_NAME_LIMIT) {
    return `Auth header name must be ${MCP_AUTH_HEADER_NAME_LIMIT} characters or fewer.`;
  }
  if (!MCP_AUTH_HEADER_NAME_PATTERN.test(name)) {
    return 'Auth header name must be a valid HTTP header token.';
  }
  if (RESERVED_MCP_AUTH_HEADER_NAMES.has(name.toLowerCase())) {
    return `Auth header ${name} is reserved by the platform.`;
  }
  return null;
}

export function validateMcpAuthHeaderPrefix(prefix: string): string | null {
  if (prefix.length > MCP_AUTH_HEADER_PREFIX_LIMIT) {
    return `Auth header prefix must be ${MCP_AUTH_HEADER_PREFIX_LIMIT} characters or fewer.`;
  }
  if (/[\r\n]/.test(prefix)) {
    return 'Auth header prefix must not contain CR or LF characters.';
  }
  return null;
}

export function resolveEffectiveMcpAuthConfig(
  current: CurrentMcpAuthConfig,
  patch: McpAuthConfigPatch
): EffectiveMcpAuthConfig {
  const authType = patch.authType ?? current.authType;
  const credentialMode = patch.credentialMode ?? current.credentialMode;
  if (authType === 'none') return { authType, credentialMode };
  if (authType === 'bearer_token' || authType === 'oauth') {
    return {
      authType,
      credentialMode,
      headerName: 'Authorization',
      headerPrefix: 'Bearer '
    };
  }
  const continuingCustomHeader = current.authType === 'custom_header';
  return {
    authType,
    credentialMode,
    headerName: patch.headerName ?? (continuingCustomHeader ? current.headerName || undefined : undefined),
    headerPrefix: patch.headerPrefix ?? (continuingCustomHeader ? current.headerPrefix || '' : '')
  };
}

export function validateEffectiveMcpAuthConfig(
  current: CurrentMcpAuthConfig,
  patch: McpAuthConfigPatch
): string | null {
  const effective = resolveEffectiveMcpAuthConfig(current, patch);
  if (effective.authType === 'none' && effective.credentialMode !== 'none') {
    return 'credentialMode must be none when authentication is none.';
  }
  if (
    effective.authType === 'none'
    && (patch.headerName !== undefined || patch.headerPrefix !== undefined)
  ) {
    return 'Auth header fields require authenticated MCP.';
  }
  if (effective.authType !== 'none' && effective.credentialMode === 'none') {
    return 'Authenticated MCP servers require workspace or individual credentials.';
  }
  if (effective.authType === 'custom_header' && !effective.headerName) {
    return 'Custom-header authentication requires a header name.';
  }
  if (effective.authType === 'oauth' && effective.credentialMode !== 'individual') {
    return 'OAuth requires individual credentials.';
  }
  if (
    effective.authType === 'oauth'
    && (patch.headerName !== undefined || patch.headerPrefix !== undefined)
  ) {
    return 'OAuth does not accept auth header fields.';
  }
  if (effective.headerName) {
    const headerNameError = validateMcpAuthHeaderName(effective.headerName);
    if (headerNameError) return headerNameError;
  }
  if (effective.headerPrefix !== undefined) {
    const headerPrefixError = validateMcpAuthHeaderPrefix(effective.headerPrefix);
    if (headerPrefixError) return headerPrefixError;
  }
  const collision = validateMcpPublicAuthHeaderCollision(
    patch.publicHeaders ?? current.publicHeaders,
    effective.authType,
    effective.headerName
  );
  if (collision) return collision;
  return null;
}

export function validateMcpPublicAuthHeaderCollision(
  publicHeaders: Record<string, unknown> | null | undefined,
  authType: McpAuthType,
  authHeaderName: string | null | undefined
): string | null {
  if (authType !== 'custom_header' || !authHeaderName) return null;
  const normalizedAuthHeader = authHeaderName.toLowerCase();
  return Object.keys(publicHeaders || {}).some((name) => name.toLowerCase() === normalizedAuthHeader)
    ? 'publicHeaders must not duplicate the custom authentication header.'
    : null;
}
