import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config, type ExternalIntegrationClientDescriptor } from '../config.js';
import { gatewayTokenService } from '../services/token-service.js';
import { hashToken } from '../utils/crypto.js';
import { constantTimeEqual } from '../utils/tokens.js';
import { getSessionUser } from './session.js';

export type AuthCredential = {
  type: 'session';
  sessionId: string;
};

export interface AuthContext {
  userId: string;
  credential: AuthCredential;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      externalIntegrationClient?: ExternalIntegrationClientDescriptor;
    }
  }
}

export type AuthenticatedRequest = Request & {
  auth: AuthContext;
};

export type AuthenticatedRouteHandler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => void | Promise<void>;

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new Error('Authenticated request required');
  }
  return req.auth;
}

export function authenticatedHandler(handler: AuthenticatedRouteHandler): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User session required', retryable: false } });
      return;
    }
    return handler(req as AuthenticatedRequest, res, next);
  };
}

function rejectUnauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message, retryable: false } });
}

async function authenticateUser(req: Request): Promise<AuthContext | null> {
  const session = await getSessionUser(req);
  if (!session) {
    return null;
  }
  return {
    userId: session.userId,
    credential: { type: 'session', sessionId: session.sessionId }
  };
}

function bearerToken(req: Request): string {
  const auth = req.header('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = await authenticateUser(req);
    if (!auth) {
      rejectUnauthorized(res, 'User session required');
      return;
    }
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
}

function bearerTokenMatches(req: Request, expectedToken: string): boolean {
  return constantTimeEqual(bearerToken(req), expectedToken);
}

function requireBearerToken(req: Request, res: Response, next: NextFunction, expectedToken: string): void {
  if (!bearerTokenMatches(req, expectedToken)) {
    rejectUnauthorized(res, 'Service token required');
    return;
  }
  next();
}

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  requireBearerToken(req, res, next, config.ORCH_SERVICE_TOKEN);
}

function externalIntegrationClientFromBearer(req: Request): ExternalIntegrationClientDescriptor | null {
  const token = bearerToken(req);
  if (!token) return null;
  const digest = hashToken(token);
  return config.EXTERNAL_INTEGRATION_CLIENTS.find((client) => (
    client.enabled && constantTimeEqual(digest, client.sha256)
  )) || null;
}

export function requireExternalIntegrationClient(req: Request, res: Response, next: NextFunction): void {
  const client = externalIntegrationClientFromBearer(req);
  if (!client) {
    rejectUnauthorized(res, 'External integration client token required');
    return;
  }
  req.externalIntegrationClient = client;
  next();
}

export async function requireGatewayRunToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Run token required', retryable: false } });
    return;
  }
  try {
    res.locals.gatewayRunClaims = await gatewayTokenService.verifyRunScopeToken(token);
    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid run token', retryable: false } });
  }
}
