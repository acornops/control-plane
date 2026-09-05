const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'key',
  'password',
  'secret',
  'token'
]);

/** Mirror llm-gateway's direct remote MCP endpoint boundary. */
export function validateRemoteMcpEndpoint(value: string): string | null {
  // WHATWG URL would reinterpret `https:///path` as host `path`, while the
  // gateway's RFC-style parser correctly treats it as a missing authority.
  if (!/^https:\/\/[^/?#]/i.test(value)) {
    return 'Remote MCP endpoint must be an absolute HTTPS URL.';
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return 'Remote MCP endpoint must be an absolute HTTPS URL.';
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname) {
    return 'Remote MCP endpoint must be an absolute HTTPS URL.';
  }
  if (endpoint.username || endpoint.password) {
    return 'MCP endpoint must not include credentials.';
  }
  if (endpoint.hash) {
    return 'MCP endpoint must not include a fragment.';
  }
  const queryKeys = new Set(
    [...endpoint.searchParams.keys()].map((key) => key.trim().toLowerCase())
  );
  if ([...queryKeys].some((key) => SECRET_QUERY_KEYS.has(key))) {
    return 'MCP endpoint credentials must use the authentication fields.';
  }
  return null;
}
