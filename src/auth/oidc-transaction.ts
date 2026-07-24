import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';

const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const OIDC_TRANSACTION_COOKIE_PATH = '/api/v1/auth/oidc/callback';

function cookieName(): string {
  return `${config.SESSION_COOKIE_NAME}_oidc_transaction`;
}

function bindingHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createOidcBrowserTransaction(): { cookieValue: string; bindingHash: string } {
  const cookieValue = randomBytes(32).toString('base64url');
  return { cookieValue, bindingHash: bindingHash(cookieValue) };
}

export function setOidcBrowserTransactionCookie(res: Response, value: string): void {
  res.cookie(cookieName(), value, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OIDC_TRANSACTION_TTL_MS,
    path: OIDC_TRANSACTION_COOKIE_PATH
  });
}

export function clearOidcBrowserTransactionCookie(res: Response): void {
  res.clearCookie(cookieName(), { path: OIDC_TRANSACTION_COOKIE_PATH });
}

export function oidcBrowserBindingHash(req: Request): string | undefined {
  const value = req.cookies?.[cookieName()] as unknown;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    ? bindingHash(value)
    : undefined;
}
