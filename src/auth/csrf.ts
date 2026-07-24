import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { allowedReturnToOrigins } from './origins.js';
import { config } from '../config.js';
import { validAdminCsrfRequest } from './admin-csrf.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_VERSION = 'v1';
const CSRF_REQUIRED_WITHOUT_SESSION_PATHS = new Set([
  '/api/v1/auth/password/login',
  '/api/v1/auth/password/signup',
  '/api/v1/auth/password/verify-email',
  '/api/v1/auth/password/resend-verification',
  '/api/v1/auth/password/forgot',
  '/api/v1/auth/password/reset',
  '/api/v1/auth/logout'
]);

function signCsrfNonce(nonce: string): string {
  return createHmac('sha256', config.CSRF_SECRET).update(nonce).digest('base64url');
}

function createCsrfToken(): string {
  const nonce = randomBytes(32).toString('base64url');
  return `${CSRF_VERSION}.${nonce}.${signCsrfNonce(nonce)}`;
}

function tokenSignatureMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isValidCsrfToken(token: string | undefined): token is string {
  if (!token) return false;
  const [version, nonce, signature, extra] = token.split('.');
  if (version !== CSRF_VERSION || !nonce || !signature || extra !== undefined) {
    return false;
  }
  return tokenSignatureMatches(signature, signCsrfNonce(nonce));
}

function setCsrfCookie(res: Response, token: string): void {
  res.cookie(config.CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: config.SESSION_MAX_AGE_SECONDS * 1000,
    path: '/'
  });
}

export function getOrSetCsrfToken(req: Request, res: Response): string {
  const existing = req.cookies?.[config.CSRF_COOKIE_NAME] as string | undefined;
  if (isValidCsrfToken(existing)) {
    return existing;
  }
  const token = createCsrfToken();
  setCsrfCookie(res, token);
  if (req.cookies) {
    req.cookies[config.CSRF_COOKIE_NAME] = token;
  }
  return token;
}

function originFromHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isAllowedRequestOrigin(req: Request): boolean {
  const origin = originFromHeader(req.header('origin'));
  const referer = originFromHeader(req.header('referer'));
  const candidate = origin || referer;
  if (!candidate) {
    return true;
  }
  if (config.CORS_ORIGIN.trim() === '*' && config.NODE_ENV !== 'production') {
    return true;
  }
  return allowedReturnToOrigins().has(candidate);
}

function rejectCsrf(res: Response): void {
  res.status(403).json({
    error: {
      code: 'CSRF_TOKEN_REQUIRED',
      message: 'A valid CSRF token is required for this request',
      retryable: false
    }
  });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/admin/v1' || req.path.startsWith('/admin/v1/')) {
    next();
    return;
  }

  if (req.path === '/admin-auth/logout') {
    if (!validAdminCsrfRequest(req)) {
      rejectCsrf(res);
      return;
    }
    next();
    return;
  }

  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    getOrSetCsrfToken(req, res);
    next();
    return;
  }

  const sessionCookie = req.cookies?.[config.SESSION_COOKIE_NAME] as string | undefined;
  if (!sessionCookie && !CSRF_REQUIRED_WITHOUT_SESSION_PATHS.has(req.path)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[config.CSRF_COOKIE_NAME] as string | undefined;
  const headerToken = req.header(config.CSRF_HEADER_NAME);
  if (!isAllowedRequestOrigin(req) || !isValidCsrfToken(cookieToken) || headerToken !== cookieToken) {
    rejectCsrf(res);
    return;
  }

  next();
}
