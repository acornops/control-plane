import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';
import { allowedReturnToOrigins } from './origins.js';

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

type OidcStatePurpose = 'login' | 'link';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

interface OidcStateRecord {
  provider: string;
  purpose?: OidcStatePurpose;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo?: string;
  linkUserId?: string;
  createdAt: number;
}

interface DiscoveryCacheEntry {
  discovery: OidcDiscovery;
  cachedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(value: string): string {
  return base64UrlEncode(createHash('sha256').update(value).digest());
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return `Basic ${encoded}`;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sanitizeReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return raw;
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

function claimsFromJwtPayload(payload: JWTPayload): Partial<UserInfoResponse> {
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
    headers.authorization = basicAuthHeader(config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET);
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

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = sha256Base64Url(verifier);
  return { verifier, challenge };
}

async function discoverOidcConfiguration(issuerUrl: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.cachedAt < 300000) {
    return cached.discovery;
  }

  const url = `${issuerUrl}/.well-known/openid-configuration`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for issuer ${issuerUrl} (${response.status})`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = toOptionalString(json.authorization_endpoint);
  const tokenEndpoint = toOptionalString(json.token_endpoint);
  const issuer = toOptionalString(json.issuer);
  if (!authorizationEndpoint || !tokenEndpoint || !issuer) {
    throw new Error('OIDC discovery response missing required endpoints');
  }

  const discovery: OidcDiscovery = {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    userinfo_endpoint: toOptionalString(json.userinfo_endpoint),
    jwks_uri: toOptionalString(json.jwks_uri)
  };

  discoveryCache.set(issuerUrl, { discovery, cachedAt: Date.now() });
  return discovery;
}

async function verifyIdToken(
  idToken: string,
  discovery: OidcDiscovery,
  expectedNonce: string
): Promise<Partial<UserInfoResponse>> {
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
  return claimsFromJwtPayload(verification.payload);
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

async function fetchUserInfo(accessToken: string, endpoint: string): Promise<Partial<UserInfoResponse>> {
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

  const userInfo = (await userInfoResp.json()) as Record<string, unknown>;
  return {
    sub: toOptionalString(userInfo.sub),
    email: toOptionalString(userInfo.email),
    email_verified: typeof userInfo.email_verified === 'boolean' ? userInfo.email_verified : undefined,
    preferred_username: toOptionalString(userInfo.preferred_username),
    name: toOptionalString(userInfo.name)
  };
}

async function buildAuthorizationUrlForPurpose(
  purpose: OidcStatePurpose,
  redirectUri: string,
  returnTo?: string,
  linkUserId?: string
): Promise<string> {
  validateRedirectUri(redirectUri);
  // Discovery must use the control-plane reachable issuer URL.
  // Browser-facing endpoint differences should be handled via explicit authorization endpoint override.
  const discovery = await discoverOidcConfiguration(config.OIDC_ISSUER_URL);
  const { verifier, challenge } = createPkcePair();
  const state = randomUUID();
  const nonce = randomUUID();

  const stateRecord: OidcStateRecord = {
    provider: config.OIDC_PROVIDER_NAME,
    purpose,
    state,
    nonce,
    codeVerifier: verifier,
    redirectUri,
    returnTo: sanitizeReturnTo(returnTo),
    linkUserId,
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
  return `${authorizationEndpoint}?${params.toString()}`;
}

export async function buildAuthorizationUrl(redirectUri: string, returnTo?: string): Promise<string> {
  return buildAuthorizationUrlForPurpose('login', redirectUri, returnTo);
}

export async function buildLinkAuthorizationUrl(userId: string, redirectUri: string, returnTo?: string): Promise<string> {
  return buildAuthorizationUrlForPurpose('link', redirectUri, returnTo, userId);
}

export async function exchangeCodeForUser(
  state: string,
  code: string
): Promise<{ userInfo: UserInfoResponse; returnTo?: string; purpose: OidcStatePurpose; linkUserId?: string }> {
  const stateRaw = await redis.get(`cp:oidc:state:${state}`);
  const stateRecord = stateRaw ? (JSON.parse(stateRaw) as OidcStateRecord) : null;
  if (!stateRecord) {
    throw new Error('Invalid OIDC state');
  }

  if (Date.now() - stateRecord.createdAt > 10 * 60 * 1000) {
    await redis.del(`cp:oidc:state:${state}`);
    throw new Error('Expired OIDC state');
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

  const token = (await tokenResp.json()) as TokenResponse;
  if (typeof token.id_token !== 'string') {
    throw new Error('OIDC token response missing id_token');
  }
  const idTokenClaims = await verifyIdToken(token.id_token, discovery, stateRecord.nonce);

  let userInfoClaims: Partial<UserInfoResponse> = {};
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

  const userInfo = mergeUserClaims(idTokenClaims, userInfoClaims, { requireUserInfoSubject });
  await redis.del(`cp:oidc:state:${state}`);
  return {
    userInfo,
    returnTo: stateRecord.returnTo,
    purpose: stateRecord.purpose || 'login',
    linkUserId: stateRecord.linkUserId
  };
}
