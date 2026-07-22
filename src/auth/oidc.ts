import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';
import { constantTimeEqual } from '../utils/tokens.js';
import { allowedReturnToOrigins } from './origins.js';
import { createPkcePair, oidcClientBasicAuthHeader } from './oidc-crypto.js';
export { createPkcePair } from './oidc-crypto.js';

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface UserInfoResponse {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  name?: string;
}

export type OidcClaims = Record<string, unknown>;

type OidcStatePurpose = 'login' | 'link' | 'integration_link';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
}

interface OidcStateRecord {
  version: 2;
  provider: string;
  purpose: OidcStatePurpose;
  state: string;
  nonce: string;
  codeVerifier: string;
  browserBindingHash: string;
  redirectUri: string;
  returnTo?: string;
  linkUserId?: string;
  linkSessionId?: string;
  createdAt: number;
}

interface DiscoveryCacheEntry {
  discovery: OidcDiscovery;
  cachedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const oidcStatePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonObject(value: unknown): OidcClaims | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as OidcClaims
    : null;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function expectedDiscoveryIssuers(issuerUrl: string): Set<string> {
  const issuers = new Set([issuerUrl]);
  if (issuerUrl === config.OIDC_ISSUER_URL && config.OIDC_PUBLIC_ISSUER_URL) {
    issuers.add(config.OIDC_PUBLIC_ISSUER_URL);
  }
  return issuers;
}

export function sanitizeOidcReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) {
    try {
      const base = new URL(config.MANAGEMENT_CONSOLE_BASE_URL);
      const parsed = new URL(raw, base);
      if (parsed.origin === base.origin) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return undefined;
    }
  }

  try {
    const parsed = new URL(raw);
    if (allowedReturnToOrigins().has(parsed.origin)) {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function validateRedirectUri(redirectUri: string): void {
  if (redirectUri !== config.OIDC_REDIRECT_URI) {
    throw new Error('Invalid OIDC redirect_uri');
  }
}

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.OIDC_HTTP_TIMEOUT_MS);
  const requestInit = { ...init };
  delete requestInit.signal;
  try {
    return await fetch(input, {
      ...requestInit,
      signal: controller.signal
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OIDC request timed out after ${config.OIDC_HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function claimsFromJwtPayload(payload: Record<string, unknown>): Partial<UserInfoResponse> {
  return {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    email: toOptionalString(payload.email),
    email_verified: typeof payload.email_verified === 'boolean' ? payload.email_verified : undefined,
    preferred_username: toOptionalString(payload.preferred_username),
    name: toOptionalString(payload.name)
  };
}

export function mergeUserClaims(
  idTokenClaims: Partial<UserInfoResponse>,
  userInfoClaims: Partial<UserInfoResponse>,
  options: { requireUserInfoSubject?: boolean } = {}
): UserInfoResponse {
  if (options.requireUserInfoSubject && !userInfoClaims.sub) {
    throw new Error('OIDC userinfo missing subject');
  }
  if (idTokenClaims.sub && userInfoClaims.sub && idTokenClaims.sub !== userInfoClaims.sub) {
    throw new Error('OIDC subject mismatch');
  }

  const sub = idTokenClaims.sub ?? userInfoClaims.sub;
  if (!sub) {
    throw new Error('OIDC identity claims missing subject');
  }
  return {
    sub,
    email: userInfoClaims.email ?? idTokenClaims.email,
    email_verified: userInfoClaims.email_verified ?? idTokenClaims.email_verified,
    preferred_username: userInfoClaims.preferred_username ?? idTokenClaims.preferred_username,
    name: userInfoClaims.name ?? idTokenClaims.name
  };
}

function buildTokenExchangeRequest(
  stateRecord: OidcStateRecord,
  code: string
): { headers: Record<string, string>; body: string } {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: stateRecord.redirectUri,
    code_verifier: stateRecord.codeVerifier
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded'
  };

  if (config.OIDC_TOKEN_ENDPOINT_AUTH_METHOD === 'client_secret_basic') {
    if (!config.OIDC_CLIENT_SECRET) {
      throw new Error('OIDC_CLIENT_SECRET is required for client_secret_basic');
    }
    params.set('client_id', config.OIDC_CLIENT_ID);
    headers.authorization = oidcClientBasicAuthHeader(config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET);
    return { headers, body: params.toString() };
  }

  if (config.OIDC_TOKEN_ENDPOINT_AUTH_METHOD === 'client_secret_post') {
    if (!config.OIDC_CLIENT_SECRET) {
      throw new Error('OIDC_CLIENT_SECRET is required for client_secret_post');
    }
    params.set('client_id', config.OIDC_CLIENT_ID);
    params.set('client_secret', config.OIDC_CLIENT_SECRET);
    return { headers, body: params.toString() };
  }

  params.set('client_id', config.OIDC_CLIENT_ID);
  return { headers, body: params.toString() };
}

export async function discoverOidcConfiguration(issuerUrl: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.cachedAt < 300000) {
    return cached.discovery;
  }

  const url = `${issuerUrl}/.well-known/openid-configuration`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for issuer ${issuerUrl} (${response.status})`);
  }

  const json = jsonObject(await response.json());
  if (!json) {
    throw new Error('OIDC discovery response must be a JSON object');
  }
  const authorizationEndpoint = toOptionalString(json.authorization_endpoint);
  const tokenEndpoint = toOptionalString(json.token_endpoint);
  const issuer = toOptionalString(json.issuer);
  if (!authorizationEndpoint || !tokenEndpoint || !issuer) {
    throw new Error('OIDC discovery response missing required endpoints');
  }
  if (!expectedDiscoveryIssuers(issuerUrl).has(issuer)) {
    throw new Error('OIDC discovery issuer mismatch');
  }
  if (!httpUrl(authorizationEndpoint) || !httpUrl(tokenEndpoint)) {
    throw new Error('OIDC discovery response contains an invalid endpoint');
  }

  const userInfoEndpoint = toOptionalString(json.userinfo_endpoint);
  const jwksUri = toOptionalString(json.jwks_uri);
  const endSessionEndpoint = toOptionalString(json.end_session_endpoint);
  if ([userInfoEndpoint, jwksUri, endSessionEndpoint].some((endpoint) => endpoint && !httpUrl(endpoint))) {
    throw new Error('OIDC discovery response contains an invalid endpoint');
  }

  const discovery: OidcDiscovery = {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    userinfo_endpoint: userInfoEndpoint,
    jwks_uri: jwksUri,
    end_session_endpoint: endSessionEndpoint
  };

  discoveryCache.set(issuerUrl, { discovery, cachedAt: Date.now() });
  return discovery;
}

async function verifyIdToken(
  idToken: string,
  discovery: OidcDiscovery,
  expectedNonce: string
): Promise<OidcClaims> {
  const jwksUri = config.OIDC_JWKS_URI_OVERRIDE || discovery.jwks_uri;
  if (!jwksUri) {
    throw new Error('OIDC discovery missing jwks_uri');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: config.OIDC_HTTP_TIMEOUT_MS
  });
  const verification = await jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: config.OIDC_CLIENT_ID,
    clockTolerance: 30
  });

  validateOidcNonce(verification.payload, expectedNonce);
  validateOidcAuthorizedParty(verification.payload);
  return { ...verification.payload };
}

export function validateOidcNonce(payload: JWTPayload, expectedNonce: string): void {
  const tokenNonce = toOptionalString(payload.nonce);
  if (!tokenNonce) {
    throw new Error('OIDC nonce missing');
  }
  if (tokenNonce !== expectedNonce) {
    throw new Error('OIDC nonce mismatch');
  }
}

export function validateOidcAuthorizedParty(payload: JWTPayload): void {
  const authorizedParty = toOptionalString(payload.azp);
  if (authorizedParty && authorizedParty !== config.OIDC_CLIENT_ID) {
    throw new Error('OIDC authorized party mismatch');
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && !authorizedParty) {
    throw new Error('OIDC authorized party missing for multiple audiences');
  }
}

async function fetchUserInfo(accessToken: string, endpoint: string): Promise<OidcClaims> {
  const userInfoResp = await fetchWithTimeout(endpoint, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!userInfoResp.ok) {
    logger.error(
      {
        status: userInfoResp.status,
        provider: config.OIDC_PROVIDER_NAME,
        endpointType: 'userinfo'
      },
      'OIDC userinfo failed'
    );
    throw new Error(`OIDC userinfo failed (${userInfoResp.status})`);
  }

  const claims = jsonObject(await userInfoResp.json());
  if (!claims) {
    throw new Error('OIDC userinfo response must be a JSON object');
  }
  return claims;
}

function parseOidcStateRecord(
  raw: string | null,
  expectedState: string,
  expectedBrowserBindingHash: string | undefined
): OidcStateRecord | null {
  if (!raw || !expectedBrowserBindingHash || !/^[a-f0-9]{64}$/.test(expectedBrowserBindingHash)) return null;
  let record: OidcClaims | null = null;
  try {
    record = jsonObject(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!record) return null;
  const purpose = record.purpose;
  const returnTo = record.returnTo;
  const linkUserId = record.linkUserId;
  const linkSessionId = record.linkSessionId;
  if (
    record.version !== 2
    || record.provider !== config.OIDC_PROVIDER_NAME
    || record.state !== expectedState
    || !oidcStatePattern.test(expectedState)
    || !['login', 'link', 'integration_link'].includes(purpose as string)
    || typeof record.nonce !== 'string'
    || record.nonce.length < 16
    || typeof record.codeVerifier !== 'string'
    || record.codeVerifier.length < 43
    || typeof record.browserBindingHash !== 'string'
    || !constantTimeEqual(record.browserBindingHash, expectedBrowserBindingHash)
    || record.redirectUri !== config.OIDC_REDIRECT_URI
    || (returnTo !== undefined && (typeof returnTo !== 'string' || sanitizeOidcReturnTo(returnTo) !== returnTo))
    || !Number.isFinite(record.createdAt)
  ) return null;

  const isLink = purpose === 'link';
  if (
    (isLink && (typeof linkUserId !== 'string' || !linkUserId || typeof linkSessionId !== 'string' || !linkSessionId))
    || (!isLink && (linkUserId !== undefined || linkSessionId !== undefined))
  ) return null;

  const age = Date.now() - (record.createdAt as number);
  if (age < -30_000 || age > 10 * 60 * 1000) return null;
  return record as unknown as OidcStateRecord;
}

async function buildAuthorizationUrlForPurpose(
  purpose: OidcStatePurpose,
  redirectUri: string,
  browserBindingHash: string,
  returnTo?: string,
  options: { linkUserId?: string; linkSessionId?: string } = {}
): Promise<string> {
  validateRedirectUri(redirectUri);
  // Discovery must use the control-plane reachable issuer URL.
  // Browser-facing endpoint differences should be handled via explicit authorization endpoint override.
  const discovery = await discoverOidcConfiguration(config.OIDC_ISSUER_URL);
  const { verifier, challenge } = createPkcePair();
  const state = randomUUID();
  const nonce = randomUUID();

  const stateRecord: OidcStateRecord = {
    version: 2,
    provider: config.OIDC_PROVIDER_NAME,
    purpose,
    state,
    nonce,
    codeVerifier: verifier,
    browserBindingHash,
    redirectUri,
    returnTo: sanitizeOidcReturnTo(returnTo),
    linkUserId: options.linkUserId,
    linkSessionId: options.linkSessionId,
    createdAt: Date.now()
  };
  await redis.setex(`cp:oidc:state:${state}`, 600, JSON.stringify(stateRecord));

  const params = new URLSearchParams({
    client_id: config.OIDC_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.OIDC_SCOPES,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  const authorizationEndpoint = config.OIDC_AUTHORIZATION_ENDPOINT_OVERRIDE || discovery.authorization_endpoint;
  const authorizationUrl = httpUrl(authorizationEndpoint);
  if (!authorizationUrl || (config.NODE_ENV === 'production' && authorizationUrl.protocol !== 'https:')) {
    throw new Error('OIDC authorization endpoint must be browser-reachable over HTTPS');
  }
  for (const [name, value] of params) authorizationUrl.searchParams.set(name, value);
  return authorizationUrl.toString();
}

export async function buildAuthorizationUrl(
  redirectUri: string,
  browserBindingHash: string,
  returnTo?: string
): Promise<string> {
  return buildAuthorizationUrlForPurpose('login', redirectUri, browserBindingHash, returnTo);
}

export async function buildLinkAuthorizationUrl(
  userId: string,
  sessionId: string,
  redirectUri: string,
  browserBindingHash: string,
  returnTo?: string
): Promise<string> {
  return buildAuthorizationUrlForPurpose(
    'link', redirectUri, browserBindingHash, returnTo, { linkUserId: userId, linkSessionId: sessionId }
  );
}

export async function buildIntegrationLinkAuthorizationUrl(
  redirectUri: string,
  browserBindingHash: string,
  returnTo?: string
): Promise<string> {
  return buildAuthorizationUrlForPurpose('integration_link', redirectUri, browserBindingHash, returnTo);
}

export async function exchangeCodeForUser(
  state: string,
  code: string,
  browserBindingHash: string | undefined
): Promise<{
  userInfo: UserInfoResponse;
  returnTo?: string;
  purpose: OidcStatePurpose;
  linkUserId?: string;
  linkSessionId?: string;
  idToken: string;
  issuer: string;
  idTokenClaims: OidcClaims;
  userInfoClaims: OidcClaims;
}> {
  if (!oidcStatePattern.test(state)) {
    throw new Error('Invalid OIDC state');
  }
  const stateRaw = await redis.getdel(`cp:oidc:state:${state}`);
  const stateRecord = parseOidcStateRecord(stateRaw, state, browserBindingHash);
  if (!stateRecord) {
    throw new Error('Invalid OIDC state');
  }

  // Token + userinfo exchange must always use the control-plane reachable internal issuer URL.
  const discovery = await discoverOidcConfiguration(config.OIDC_ISSUER_URL);

  const tokenRequest = buildTokenExchangeRequest(stateRecord, code);

  const tokenEndpoint = config.OIDC_TOKEN_ENDPOINT_OVERRIDE || discovery.token_endpoint;
  const tokenResp = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: tokenRequest.headers,
    body: tokenRequest.body
  });

  if (!tokenResp.ok) {
    logger.error(
      {
        status: tokenResp.status,
        provider: config.OIDC_PROVIDER_NAME,
        endpointType: 'token'
      },
      'OIDC token exchange failed'
    );
    throw new Error(`OIDC token exchange failed (${tokenResp.status})`);
  }

  const token = jsonObject(await tokenResp.json()) as (OidcClaims & Partial<TokenResponse>) | null;
  if (!token || typeof token.id_token !== 'string' || token.id_token.length === 0) {
    throw new Error('OIDC token response missing id_token');
  }
  if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
    throw new Error('OIDC token response missing access_token');
  }
  if (typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') {
    throw new Error('OIDC token response has unsupported token_type');
  }
  const idTokenClaims = await verifyIdToken(token.id_token, discovery, stateRecord.nonce);

  let userInfoClaims: OidcClaims = {};
  let requireUserInfoSubject = false;
  if (config.OIDC_USE_USERINFO) {
    const userInfoEndpoint = config.OIDC_USERINFO_ENDPOINT_OVERRIDE || discovery.userinfo_endpoint;
    if (userInfoEndpoint) {
      userInfoClaims = await fetchUserInfo(token.access_token, userInfoEndpoint);
      requireUserInfoSubject = true;
    } else {
      logger.warn({ issuer: config.OIDC_ISSUER_URL }, 'OIDC discovery has no userinfo endpoint');
    }
  }

  const userInfo = mergeUserClaims(
    claimsFromJwtPayload(idTokenClaims),
    {
      sub: toOptionalString(userInfoClaims.sub),
      email: toOptionalString(userInfoClaims.email),
      email_verified: typeof userInfoClaims.email_verified === 'boolean' ? userInfoClaims.email_verified : undefined,
      preferred_username: toOptionalString(userInfoClaims.preferred_username),
      name: toOptionalString(userInfoClaims.name)
    },
    { requireUserInfoSubject }
  );
  return {
    userInfo,
    returnTo: stateRecord.returnTo,
    purpose: stateRecord.purpose || 'login',
    linkUserId: stateRecord.linkUserId,
    linkSessionId: stateRecord.linkSessionId,
    idToken: token.id_token,
    issuer: discovery.issuer,
    idTokenClaims,
    userInfoClaims
  };
}
