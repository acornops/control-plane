import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { discoverOidcConfiguration } from './oidc.js';
import type { BrowserSession } from './session.js';

interface OidcLogoutRequest {
  version: 1;
  userId: string;
  provider: string;
  issuer: string;
  idToken: string;
  createdAt: number;
}

interface OidcLogoutState {
  version: 1;
  userId: string;
  provider: string;
  issuer: string;
  createdAt: number;
}

const LOGOUT_REQUEST_TTL_SECONDS = 60;
const LOGOUT_STATE_TTL_SECONDS = 600;
const MAX_CLOCK_SKEW_MS = 30_000;

function randomHandle(): string {
  return randomBytes(32).toString('base64url');
}

function logoutRequestKey(handle: string): string {
  return `cp:oidc:logout_request:${handle}`;
}

function logoutStateKey(state: string): string {
  return `cp:oidc:logout_state:${state}`;
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as unknown;
    return record && typeof record === 'object' && !Array.isArray(record)
      ? record as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseLogoutRequest(raw: string | null): OidcLogoutRequest | null {
  const record = parseRecord(raw);
  if (
    record?.version !== 1
    || !isNonEmptyString(record.userId)
    || !isNonEmptyString(record.provider)
    || !isNonEmptyString(record.issuer)
    || !isNonEmptyString(record.idToken)
    || !Number.isFinite(record.createdAt)
  ) return null;
  return record as unknown as OidcLogoutRequest;
}

function parseLogoutState(raw: string | null): OidcLogoutState | null {
  const record = parseRecord(raw);
  if (
    record?.version !== 1
    || !isNonEmptyString(record.userId)
    || !isNonEmptyString(record.provider)
    || !isNonEmptyString(record.issuer)
    || !Number.isFinite(record.createdAt)
  ) return null;
  return record as unknown as OidcLogoutState;
}

export async function createOidcLogoutRequest(session: BrowserSession): Promise<string | null> {
  if (session.authMethod !== 'oidc' || !session.oidc) return null;
  const handle = randomHandle();
  const record: OidcLogoutRequest = {
    version: 1,
    userId: session.userId,
    provider: session.oidc.provider,
    issuer: session.oidc.issuer,
    idToken: session.oidc.idToken,
    createdAt: Date.now()
  };
  await redis.setex(logoutRequestKey(handle), LOGOUT_REQUEST_TTL_SECONDS, JSON.stringify(record));
  return handle;
}

export async function startOidcLogout(handle: string): Promise<{
  providerUrl: string;
  userId: string;
  provider: string;
  issuer: string;
} | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(handle)) return null;
  const request = parseLogoutRequest(await redis.getdel(logoutRequestKey(handle)));
  if (!request) return null;
  const requestAge = Date.now() - request.createdAt;
  if (requestAge < -MAX_CLOCK_SKEW_MS || requestAge > LOGOUT_REQUEST_TTL_SECONDS * 1000) return null;
  const configuredIssuers = new Set(
    [config.OIDC_ISSUER_URL, config.OIDC_PUBLIC_ISSUER_URL].filter(isNonEmptyString),
  );
  if (request.provider !== config.OIDC_PROVIDER_NAME || !configuredIssuers.has(request.issuer)) return null;

  let endSessionEndpoint = config.OIDC_END_SESSION_ENDPOINT_OVERRIDE;
  if (!endSessionEndpoint) {
    const discovery = await discoverOidcConfiguration(config.OIDC_ISSUER_URL);
    if (discovery.issuer !== request.issuer) return null;
    endSessionEndpoint = discovery.end_session_endpoint;
  }
  if (!endSessionEndpoint) return null;

  let providerUrl: URL;
  try {
    providerUrl = new URL(endSessionEndpoint);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(providerUrl.protocol)) return null;
  if (config.NODE_ENV === 'production' && providerUrl.protocol !== 'https:') return null;

  const state = randomHandle();
  const stateRecord: OidcLogoutState = {
    version: 1,
    userId: request.userId,
    provider: request.provider,
    issuer: request.issuer,
    createdAt: Date.now()
  };
  await redis.setex(logoutStateKey(state), LOGOUT_STATE_TTL_SECONDS, JSON.stringify(stateRecord));
  providerUrl.searchParams.set('id_token_hint', request.idToken);
  providerUrl.searchParams.set('client_id', config.OIDC_CLIENT_ID);
  providerUrl.searchParams.set('post_logout_redirect_uri', config.OIDC_POST_LOGOUT_REDIRECT_URI);
  providerUrl.searchParams.set('state', state);
  return {
    providerUrl: providerUrl.toString(),
    userId: request.userId,
    provider: request.provider,
    issuer: request.issuer
  };
}

export async function consumeOidcLogoutState(state: string): Promise<OidcLogoutState | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return null;
  const record = parseLogoutState(await redis.getdel(logoutStateKey(state)));
  if (!record) return null;
  const age = Date.now() - record.createdAt;
  const configuredIssuers = new Set(
    [config.OIDC_ISSUER_URL, config.OIDC_PUBLIC_ISSUER_URL].filter(isNonEmptyString),
  );
  if (
    age < -MAX_CLOCK_SKEW_MS
    || age > LOGOUT_STATE_TTL_SECONDS * 1000
    || record.provider !== config.OIDC_PROVIDER_NAME
    || !configuredIssuers.has(record.issuer)
  ) return null;
  return record;
}

export function consoleLogoutResultUrl(result: 'success' | 'local_only' | 'incomplete'): string {
  const url = new URL('/', config.MANAGEMENT_CONSOLE_BASE_URL);
  url.searchParams.set('logout_result', result);
  return url.toString();
}
