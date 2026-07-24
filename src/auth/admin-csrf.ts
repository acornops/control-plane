import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

function signature(nonce: string): string {
  return createHmac('sha256', config.ADMIN_CSRF_SECRET).update(nonce).digest('base64url');
}

export function validAdminCsrfToken(value: string | undefined): value is string {
  if (!value) return false;
  const [version, nonce, actual, extra] = value.split('.');
  if (version !== 'v1' || !nonce || !actual || extra !== undefined) return false;
  const expected = signature(nonce);
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function getOrSetAdminCsrfToken(req: Request, res: Response): string {
  const existing = req.cookies?.[config.ADMIN_CSRF_COOKIE_NAME] as string | undefined;
  if (validAdminCsrfToken(existing)) return existing;
  const nonce = randomBytes(32).toString('base64url');
  const token = `v1.${nonce}.${signature(nonce)}`;
  res.cookie(config.ADMIN_CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: config.ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
    path: '/'
  });
  return token;
}

export function clearAdminCsrfCookie(res: Response): void {
  res.clearCookie(config.ADMIN_CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
}

export function validAdminCsrfRequest(req: Request): boolean {
  const expectedOrigin = new URL(config.PLATFORM_ADMIN_CONSOLE_BASE_URL).origin;
  const origin = req.header('origin');
  const referer = req.header('referer');
  let actualOrigin: string | null = null;
  try { actualOrigin = new URL(origin || referer || '').origin; } catch { return false; }
  const cookie = req.cookies?.[config.ADMIN_CSRF_COOKIE_NAME] as string | undefined;
  return actualOrigin === expectedOrigin && validAdminCsrfToken(cookie) && req.header(config.ADMIN_CSRF_HEADER_NAME) === cookie;
}

export function requireAdminCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!validAdminCsrfRequest(req)) {
    res.status(403).json({ error: { code: 'CSRF_TOKEN_REQUIRED', message: 'A valid CSRF token is required for this request', retryable: false } });
    return;
  }
  next();
}
