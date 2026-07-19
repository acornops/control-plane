const MAX_PUBLIC_HEADERS = 64;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CREDENTIAL_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token'
]);
const CREDENTIAL_PATTERNS = ['token', 'secret', 'credential', 'api-key', 'apikey'];
const RESERVED_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
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

export class InvalidMcpPublicHeadersError extends Error {
  readonly code = 'INVALID_MCP_PUBLIC_HEADERS';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidMcpPublicHeadersError';
  }
}

export function validateMcpPublicHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const entries = Object.entries(headers);
  if (entries.length > MAX_PUBLIC_HEADERS) {
    throw new InvalidMcpPublicHeadersError(`publicHeaders may include at most ${MAX_PUBLIC_HEADERS} headers`);
  }

  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!name || name !== name.trim()) {
      throw new InvalidMcpPublicHeadersError('header names must not be empty or padded');
    }
    if (name.length > MAX_HEADER_NAME_LENGTH) {
      throw new InvalidMcpPublicHeadersError(`header names must be ${MAX_HEADER_NAME_LENGTH} characters or fewer`);
    }
    if (!HEADER_NAME.test(name)) {
      throw new InvalidMcpPublicHeadersError(`header ${name} is not a valid HTTP header token`);
    }
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      throw new InvalidMcpPublicHeadersError(`duplicate header name: ${name}`);
    }
    seen.add(normalized);
    if (RESERVED_NAMES.has(normalized)) {
      throw new InvalidMcpPublicHeadersError(`header ${name} is reserved by the platform`);
    }
    if (CREDENTIAL_NAMES.has(normalized) || CREDENTIAL_PATTERNS.some((pattern) => normalized.includes(pattern))) {
      throw new InvalidMcpPublicHeadersError(`header ${name} may not contain credentials`);
    }
    if (typeof value !== 'string') {
      throw new InvalidMcpPublicHeadersError(`header ${name} must have a string value`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new InvalidMcpPublicHeadersError(`header ${name} value must be ${MAX_HEADER_VALUE_LENGTH} characters or fewer`);
    }
    if (value.includes('\r') || value.includes('\n')) {
      throw new InvalidMcpPublicHeadersError(`header ${name} must not contain CR or LF characters`);
    }
    result[name] = value;
  }
  return result;
}
