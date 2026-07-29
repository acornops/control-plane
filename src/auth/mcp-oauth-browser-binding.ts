import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';

const MCP_OAUTH_BINDING_TTL_MS = 10 * 60 * 1000;
const PRODUCTION_COOKIE_NAME = '__Host-acornops-mcp-oauth-binding';
const DEVELOPMENT_COOKIE_NAME = 'acornops-mcp-oauth-binding';
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function cookieName(): string {
  return config.NODE_ENV === 'production'
    ? PRODUCTION_COOKIE_NAME
    : DEVELOPMENT_COOKIE_NAME;
}

function hashBinding(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validCookieValue(value: unknown): value is string {
  return typeof value === 'string' && COOKIE_VALUE_PATTERN.test(value);
}

function setBindingCookie(res: Response, value: string): void {
  res.cookie(cookieName(), value, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MCP_OAUTH_BINDING_TTL_MS,
    path: '/'
  });
}

export function getOrCreateMcpOAuthBrowserBinding(
  req: Request,
  res: Response
): string {
  const current = req.cookies?.[cookieName()] as unknown;
  const value = validCookieValue(current)
    ? current
    : randomBytes(32).toString('base64url');
  setBindingCookie(res, value);
  if (req.cookies) req.cookies[cookieName()] = value;
  return hashBinding(value);
}

export function mcpOAuthBrowserBindingHash(req: Request): string | undefined {
  const value = req.cookies?.[cookieName()] as unknown;
  return validCookieValue(value) ? hashBinding(value) : undefined;
}
