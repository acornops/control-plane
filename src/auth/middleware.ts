import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config, type ExternalIntegrationClientDescriptor } from '../config.js';
import { gatewayTokenService } from '../services/token-service.js';
import { repo } from '../store/repository.js';
import { hashToken } from '../utils/crypto.js';
import { constantTimeEqual } from '../utils/tokens.js';
import { getSessionUser } from './session.js';

export const EXTERNAL_INTEGRATION_USER_ID_HEADER = 'x-acornops-external-user-id';
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

// `externalIntegration` is a linked-user credential. `externalIntegrationClient`
// is the bot service token used for account-link lifecycle endpoints and does
// not populate req.auth by itself.
export const ACTOR_KINDS = ['user', 'externalIntegration', 'externalIntegrationClient'] as const;
export type ActorKind = typeof ACTOR_KINDS[number];
type ActorRequirement = readonly [ActorKind, ...ActorKind[]];

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

function externalUserIdFromHeader(req: Request): string | null {
  const raw = req.header(EXTERNAL_INTEGRATION_USER_ID_HEADER);
  const externalUserId = typeof raw === 'string' ? raw.trim() : '';
  return externalUserId.length > 0 && externalUserId.length <= 128 ? externalUserId : null;
}

type ActorAuthenticationResult =
  | {
      authenticated: true;
      auth?: AuthContext;
    }
  | {
      authenticated: false;
      message?: string;
    };

function authenticateExternalIntegrationClient(req: Request): ActorAuthenticationResult {
  const client = externalIntegrationClientFromBearer(req);
  if (!client) {
    return { authenticated: false, message: 'External integration client token required' };
  }
  req.externalIntegrationClient = client;
  return { authenticated: true };
}

async function authenticateExternalIntegration(req: Request): Promise<ActorAuthenticationResult> {
  const client = externalIntegrationClientFromBearer(req);
  if (!client) {
    return { authenticated: false };
  }

  const externalUserId = externalUserIdFromHeader(req);
  if (!externalUserId) {
    return { authenticated: false, message: 'Linked external integration user id required' };
  }

  const resolution = await repo.resolveExternalIntegrationUserLink({
    integrationClientId: client.id,
    provider: client.provider,
    externalUserId
  });
  if (!resolution) {
    return { authenticated: false, message: 'Linked external integration account required' };
  }

  req.externalIntegrationClient = client;
  return {
    authenticated: true,
    auth: {
      userId: resolution.user.id,
      credential: {
        type: 'external_integration',
        integrationId: client.id,
        externalUserId
      }
    }
  };
}

async function authenticateActor(req: Request, actor: ActorKind): Promise<ActorAuthenticationResult> {
  if (actor === 'user') {
    const auth = await authenticateUser(req);
    return auth ? { authenticated: true, auth } : { authenticated: false };
  }
  if (actor === 'externalIntegrationClient') {
    return authenticateExternalIntegrationClient(req);
  }
  return authenticateExternalIntegration(req);
}

function actorRequirementMessage(allowedActors: ActorRequirement): string {
  const allowed = new Set<ActorKind>(allowedActors);
  if (allowed.size === 1 && allowed.has('user')) {
    return 'User session required';
  }
  if (allowed.size === 1 && allowed.has('externalIntegration')) {
    return 'Linked external integration required';
  }
  if (allowed.size === 1 && allowed.has('externalIntegrationClient')) {
    return 'External integration client token required';
  }
  return 'User session or linked external integration required';
}

export function requireActor(allowedActors: ActorRequirement): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      let failureMessage: string | undefined;
      for (const actor of allowedActors) {
        const result = await authenticateActor(req, actor);
        if (result.authenticated) {
          if (result.auth) {
            req.auth = result.auth;
          }
          next();
          return;
        }
        failureMessage = result.message ?? failureMessage;
      }
      rejectUnauthorized(res, failureMessage ?? actorRequirementMessage(allowedActors));
    } catch (err) {
      next(err);
    }
  };
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
