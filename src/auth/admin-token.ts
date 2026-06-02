import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config, AdminScope, AdminTokenDescriptor } from '../config.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';
import { incrementAdminAuthFailures } from '../metrics.js';

export interface AdminAuthContext {
  tokenId: string;
  tokenName?: string;
  scopes: AdminScope[];
  credential: { type: 'admin_token' };
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminAuthContext;
    }
  }
}

export type AdminAuthenticatedRequest = Request & {
  admin: AdminAuthContext;
};

export type AdminRouteHandler = (
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

const invalidAuthorizationCharacters = /[\u0000-\u001f\u007f\s]/;
const memoryFailureWindows = new Map<string, { count: number; resetAt: number }>();

export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hasRequiredScope(descriptor: AdminTokenDescriptor, requiredScope: AdminScope): boolean {
  return descriptor.scopes.includes('admin:*') || descriptor.scopes.includes(requiredScope);
}

function sourceIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function hashSourceIp(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function failureCountForSource(source: string): Promise<number> {
  const windowSeconds = config.CONTROL_PLANE_ADMIN_AUTH_FAILURE_WINDOW_SECONDS;
  const key = `cp:admin_auth_failure:${source}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return count;
  } catch {
    const memoryKey = source;
    const now = Date.now();
    const current = memoryFailureWindows.get(memoryKey);
    if (!current || current.resetAt <= now) {
      memoryFailureWindows.set(memoryKey, { count: 1, resetAt: now + windowSeconds * 1000 });
      return 1;
    }
    current.count += 1;
    return current.count;
  }
}

async function noteAuthFailure(req: Request, reason: string): Promise<boolean> {
  incrementAdminAuthFailures(reason);
  const count = await failureCountForSource(sourceIp(req));
  const rateLimited = count > config.CONTROL_PLANE_ADMIN_AUTH_FAILURE_MAX_ATTEMPTS;
  logger.warn(
    {
      requestId: req.res?.locals?.requestId || null,
      sourceIpHash: hashSourceIp(sourceIp(req)),
      reason,
      rateLimited
    },
    'Admin auth failed'
  );
  return rateLimited;
}

function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Admin token required', retryable: false } });
}

function sendForbidden(res: Response): void {
  res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin token scope is not sufficient', retryable: false } });
}

function sendTooManyRequests(res: Response): void {
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many failed admin authentication attempts', retryable: true } });
}

function parseBearerToken(req: Request): { token?: string; malformed?: boolean } {
  const auth = req.header('authorization');
  if (!auth) {
    return {};
  }
  if (!auth.startsWith('Bearer ')) {
    return { malformed: true };
  }
  const token = auth.slice('Bearer '.length);
  if (!token || token.trim() !== token || invalidAuthorizationCharacters.test(token)) {
    return { malformed: true };
  }
  return { token };
}

export function requireAdminScope(requiredScope: AdminScope): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = parseBearerToken(req);
      if (!parsed.token) {
        if (await noteAuthFailure(req, parsed.malformed ? 'malformed_authorization' : 'missing_token')) {
          sendTooManyRequests(res);
          return;
        }
        sendUnauthorized(res);
        return;
      }

      const submittedHash = hashAdminToken(parsed.token);
      let matched: AdminTokenDescriptor | null = null;
      for (const descriptor of config.ADMIN_TOKEN_DESCRIPTORS) {
        if (constantTimeHexEqual(submittedHash, descriptor.sha256)) {
          matched = descriptor;
        }
      }

      if (!matched) {
        if (await noteAuthFailure(req, 'unknown_token')) {
          sendTooManyRequests(res);
          return;
        }
        sendUnauthorized(res);
        return;
      }
      if (!matched.enabled) {
        if (await noteAuthFailure(req, 'disabled_token')) {
          sendTooManyRequests(res);
          return;
        }
        sendUnauthorized(res);
        return;
      }
      if (!hasRequiredScope(matched, requiredScope)) {
        await noteAuthFailure(req, 'missing_scope');
        sendForbidden(res);
        return;
      }

      req.admin = {
        tokenId: matched.id,
        ...(matched.name ? { tokenName: matched.name } : {}),
        scopes: matched.scopes,
        credential: { type: 'admin_token' }
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function adminHandler(handler: AdminRouteHandler): RequestHandler {
  return (req, res, next) => handler(req as AdminAuthenticatedRequest, res, next);
}
