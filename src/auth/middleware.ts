import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { gatewayTokenService } from '../services/token-service.js';
import { repo } from '../store/repository.js';
import { constantTimeEqual } from '../utils/tokens.js';
import { getSessionUser } from './session.js';

export const EXTERNAL_INTEGRATION_USER_ID_HEADER = 'x-acornops-external-user-id';
export const EXTERNAL_CHAT_INTEGRATION_ID = 'external-chat';

export type AuthCredential =
  | {
      type: 'session';
      sessionId: string;
    }
  | {
      type: 'external_integration';
      integrationId: string;
      externalUserId: string;
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

function rejectUnauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message, retryable: false } });
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await getSessionUser(req);
    if (!session) {
      rejectUnauthorized(res, 'User session required');
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

function bearerToken(req: Request): string {
  const auth = req.header('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
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

export function requireExternalIntegrationServiceToken(req: Request, res: Response, next: NextFunction): void {
  requireBearerToken(req, res, next, config.EXTERNAL_INTEGRATION_SERVICE_TOKEN);
}

function externalUserIdFromHeader(req: Request): string | null {
  const raw = req.header(EXTERNAL_INTEGRATION_USER_ID_HEADER);
  const externalUserId = typeof raw === 'string' ? raw.trim() : '';
  return externalUserId.length > 0 && externalUserId.length <= 128 ? externalUserId : null;
}

export async function requireUserOrExternalIntegration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await getSessionUser(req);
    if (session) {
      req.auth = {
        userId: session.userId,
        credential: { type: 'session', sessionId: session.sessionId }
      };
      next();
      return;
    }

    if (!bearerTokenMatches(req, config.EXTERNAL_INTEGRATION_SERVICE_TOKEN)) {
      rejectUnauthorized(res, 'User session or linked external integration required');
      return;
    }

    const externalUserId = externalUserIdFromHeader(req);
    if (!externalUserId) {
      rejectUnauthorized(res, 'Linked external integration user id required');
      return;
    }

    const resolution = await repo.resolveExternalIntegrationUserLink({ externalUserId });
    if (!resolution) {
      rejectUnauthorized(res, 'Linked external integration account required');
      return;
    }

    req.auth = {
      userId: resolution.user.id,
      credential: {
        type: 'external_integration',
        integrationId: EXTERNAL_CHAT_INTEGRATION_ID,
        externalUserId
      }
    };
    next();
  } catch (err) {
    next(err);
  }
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
