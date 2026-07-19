import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { PLATFORM_ADMIN_ROLES, type AdminSessionIdentity, type PlatformAdminRole } from './admin-session.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface StateRecord {
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

function base64url(value: Buffer): string { return value.toString('base64url'); }
function csv(value: string): string[] { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function stateKey(state: string): string { return `cp:admin_oidc_state:${state}`; }

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ADMIN_OIDC_HTTP_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function discovery(): Promise<Discovery> {
  const response = await fetchWithTimeout(`${config.ADMIN_OIDC_ISSUER_URL}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error('ADMIN_OIDC_DISCOVERY_FAILED');
  const value = await response.json() as Record<string, unknown>;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error('ADMIN_OIDC_DISCOVERY_INVALID');
  }
  return value as unknown as Discovery;
}

function safeReturnTo(value: string | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export async function buildAdminAuthorizationUrl(returnTo?: string, forceReauthentication = false): Promise<string> {
  const metadata = await discovery();
  const expectedIssuer = config.ADMIN_OIDC_PUBLIC_ISSUER_URL || metadata.issuer;
  if (metadata.issuer !== expectedIssuer) throw new Error('ADMIN_OIDC_ISSUER_MISMATCH');
  const state = randomUUID();
  const nonce = randomUUID();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const record: StateRecord = { nonce, verifier, returnTo: safeReturnTo(returnTo), createdAt: Date.now() };
  await redis.setex(stateKey(state), 600, JSON.stringify(record));
  const params = new URLSearchParams({
    client_id: config.ADMIN_OIDC_CLIENT_ID,
    redirect_uri: config.ADMIN_OIDC_REDIRECT_URI,
    response_type: 'code',
    scope: config.ADMIN_OIDC_SCOPES,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  const acrValues = csv(config.ADMIN_OIDC_REQUIRED_ACR_VALUES);
  if (acrValues.length) params.set('acr_values', acrValues.join(' '));
  if (forceReauthentication) {
    params.set('prompt', 'login');
    params.set('max_age', '0');
  }
  return `${config.ADMIN_OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE || metadata.authorization_endpoint}?${params}`;
}

export function adminRolesFromClaims(payload: JWTPayload): PlatformAdminRole[] {
  const realm = payload.realm_access as { roles?: unknown } | undefined;
  const resources = payload.resource_access as Record<string, { roles?: unknown }> | undefined;
  const claimed = [
    ...(Array.isArray(realm?.roles) ? realm.roles : []),
    ...(Array.isArray(resources?.[config.ADMIN_OIDC_CLIENT_ID]?.roles) ? resources?.[config.ADMIN_OIDC_CLIENT_ID]?.roles as unknown[] : [])
  ].filter((item): item is string => typeof item === 'string');
  const configured = new Set(csv(config.ADMIN_OIDC_ALLOWED_ROLES));
  return PLATFORM_ADMIN_ROLES.filter((role) => configured.has(role) && claimed.includes(role));
}

export function adminAssuranceFromClaims(payload: JWTPayload): { acr?: string; amr: string[] } {
  const acr = typeof payload.acr === 'string' ? payload.acr : undefined;
  const amr = Array.isArray(payload.amr) ? payload.amr.filter((item): item is string => typeof item === 'string') : [];
  const requiredAcr = csv(config.ADMIN_OIDC_REQUIRED_ACR_VALUES);
  const requiredAmr = csv(config.ADMIN_OIDC_REQUIRED_AMR_VALUES);
  const accepted = (requiredAcr.length > 0 && Boolean(acr && requiredAcr.includes(acr))) ||
    (requiredAmr.length > 0 && amr.some((value) => requiredAmr.includes(value)));
  if (!accepted) throw new Error('ADMIN_MFA_REQUIRED');
  return { ...(acr ? { acr } : {}), amr };
}

export async function exchangeAdminAuthorizationCode(state: string, code: string): Promise<{ identity: AdminSessionIdentity; returnTo: string }> {
  const raw = await redis.getdel(stateKey(state));
  if (!raw) throw new Error('ADMIN_OIDC_STATE_INVALID');
  const record = JSON.parse(raw) as StateRecord;
  if (Date.now() - record.createdAt > 600_000) throw new Error('ADMIN_OIDC_STATE_EXPIRED');
  const metadata = await discovery();
  const expectedIssuer = config.ADMIN_OIDC_PUBLIC_ISSUER_URL || metadata.issuer;
  if (metadata.issuer !== expectedIssuer) throw new Error('ADMIN_OIDC_ISSUER_MISMATCH');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.ADMIN_OIDC_REDIRECT_URI,
    client_id: config.ADMIN_OIDC_CLIENT_ID,
    code_verifier: record.verifier
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!config.ADMIN_OIDC_CLIENT_SECRET) throw new Error('ADMIN_OIDC_CLIENT_SECRET_REQUIRED');
  if (config.ADMIN_OIDC_TOKEN_ENDPOINT_AUTH_METHOD === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${config.ADMIN_OIDC_CLIENT_ID}:${config.ADMIN_OIDC_CLIENT_SECRET}`).toString('base64')}`;
  } else {
    body.set('client_secret', config.ADMIN_OIDC_CLIENT_SECRET);
  }
  const tokenResponse = await fetchWithTimeout(config.ADMIN_OIDC_TOKEN_ENDPOINT_OVERRIDE || metadata.token_endpoint, { method: 'POST', headers, body: body.toString() });
  if (!tokenResponse.ok) throw new Error('ADMIN_OIDC_TOKEN_EXCHANGE_FAILED');
  const tokens = await tokenResponse.json() as Record<string, unknown>;
  if (typeof tokens.id_token !== 'string') throw new Error('ADMIN_OIDC_ID_TOKEN_REQUIRED');
  const jwks = createRemoteJWKSet(new URL(config.ADMIN_OIDC_JWKS_URI_OVERRIDE || metadata.jwks_uri), { timeoutDuration: config.ADMIN_OIDC_HTTP_TIMEOUT_MS });
  const verified = await jwtVerify(tokens.id_token, jwks, {
    issuer: expectedIssuer,
    audience: config.ADMIN_OIDC_CLIENT_ID,
    clockTolerance: 30
  });
  if (verified.payload.nonce !== record.nonce) throw new Error('ADMIN_OIDC_NONCE_INVALID');
  if (!verified.payload.sub) throw new Error('ADMIN_OIDC_SUBJECT_REQUIRED');
  const roles = adminRolesFromClaims(verified.payload);
  if (!roles.length) throw new Error('ADMIN_ROLE_REQUIRED');
  const assurance = adminAssuranceFromClaims(verified.payload);
  return {
    identity: {
      issuer: expectedIssuer,
      subject: verified.payload.sub,
      ...(typeof verified.payload.email === 'string' ? { email: verified.payload.email } : {}),
      ...(typeof verified.payload.name === 'string' ? { displayName: verified.payload.name } : {}),
      roles,
      ...assurance,
      authenticatedAt: (typeof verified.payload.auth_time === 'number' ? verified.payload.auth_time * 1000 : Date.now())
    },
    returnTo: record.returnTo
  };
}
