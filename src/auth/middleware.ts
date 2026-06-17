import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { gatewayTokenService } from '../services/token-service.js';
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

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await getSessionUser(req);
    if (!session) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User session required', retryable: false } });
      return;
    }
    req.auth = {
      userId: session.userId,
      credential: { type: 'session', sessionId: session.sessionId }
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireBearerToken(req: Request, res: Response, next: NextFunction, expectedToken: string): void {
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!constantTimeEqual(token, expectedToken)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Service token required', retryable: false } });
    return;
  }
  next();
}

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  requireBearerToken(req, res, next, config.ORCH_SERVICE_TOKEN);
}

export function requireExternalIntegrationServiceToken(req: Request, res: Response, next: NextFunction): void {
  requireBearerToken(req, res, next, config.EXTERNAL_INTEGRATION_SERVICE_TOKEN);
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
