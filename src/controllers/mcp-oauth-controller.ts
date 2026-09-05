import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import {
  getOrCreateMcpOAuthBrowserBinding,
  mcpOAuthBrowserBindingHash
} from '../auth/mcp-oauth-browser-binding.js';
import { getSessionUser } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  completeMcpOAuth,
  LlmGatewayHttpError,
  prepareMcpOAuth,
  startMcpOAuth
} from '../services/mcp-registry-client.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  consumeCurrentMcpOAuthStateCorrelation,
  deleteMcpOAuthPreparationCorrelation,
  getMcpOAuthPreparationCorrelation,
  type McpOAuthStateCorrelation,
  recordMcpOAuthPreparationCorrelation,
  recordMcpOAuthStateCorrelation
} from '../store/repository-mcp-oauth-correlations.js';
import {
  requireConnectionServer,
  type ConnectionContext
} from './mcp-connections-controller.js';
import {
  callbackErrorDetails,
  consoleRedirectUrl,
  MCP_VERIFICATION_CALLBACK_CODES,
  queryValue,
  safeReturnPath
} from './mcp-oauth-callback.js';

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function forwardOAuthGatewayError(
  err: unknown,
  res: Response,
  next: NextFunction
): void {
  if (!(err instanceof LlmGatewayHttpError)) {
    next(err);
    return;
  }
  try {
    const parsed = JSON.parse(err.responseBody) as {
      detail?: { code?: unknown; message?: unknown; retryable?: unknown };
    };
    const code = parsed.detail?.code;
    const message = parsed.detail?.message;
    if (
      typeof code === 'string'
      && /^MCP_OAUTH_[A-Z0-9_]+$/.test(code)
      && typeof message === 'string'
      && message.length <= 512
      && [400, 404, 409, 429, 503].includes(err.status)
    ) {
      if (err.status === 429 && err.retryAfter) {
        res.setHeader('Retry-After', err.retryAfter);
      }
      res.status(err.status).json({
        error: {
          code,
          message,
          retryable: parsed.detail?.retryable === true
        }
      });
      return;
    }
  } catch {
    // Fall through to the generic gateway boundary.
  }
  if (err.status === 401 || err.status === 403) {
    res.status(502).json({
      error: {
        code: 'UPSTREAM_AUTH_ERROR',
        message: 'The MCP OAuth service rejected control-plane credentials.',
        retryable: false
      }
    });
    return;
  }
  res.status(err.status === 503 ? 503 : 502).json({
    error: {
      code: err.status === 503 ? 'SERVICE_UNAVAILABLE' : 'UPSTREAM_ERROR',
      message: 'The MCP OAuth service is unavailable.',
      retryable: err.status === 503
    }
  });
}

function requireOAuthEnabled(res: Response): boolean {
  if (config.MCP_OAUTH_ENABLED) return true;
  res.status(409).json({
    error: {
      code: 'MCP_OAUTH_DISABLED',
      message: 'MCP OAuth is disabled by platform policy.',
      retryable: false
    }
  });
  return false;
}

function requireOAuthContext(context: ConnectionContext, res: Response): boolean {
  if (
    context.server.auth_type === 'oauth'
    && context.server.credential_mode === 'individual'
    && context.ownerType === 'user'
    && Number.isSafeInteger(context.membershipGeneration)
    && context.membershipGeneration! > 0
  ) {
    return true;
  }
  res.status(409).json({
    error: {
      code: 'MCP_OAUTH_INSTALLATION_REQUIRED',
      message: 'This MCP installation does not use individual OAuth.',
      retryable: false
    }
  });
  return false;
}

function requestBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function hasOnlyFields(body: Record<string, unknown>, fields: string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(body).every((key) => allowed.has(key));
}

async function auditOAuth(
  req: AuthenticatedRequest,
  context: ConnectionContext,
  stage: 'issuer_selected' | 'metadata_changed' | 'prepared' | 'started',
  metadata: Record<string, boolean | number | string[]>
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: context.workspaceId,
    category: 'mcp',
    eventType: `mcp.oauth_${stage}.v1`,
    operation: 'write',
    actorUserId: req.auth.userId,
    objectType: 'mcp_server',
    objectId: context.server.id,
    objectName: context.server.server_name,
    summary: `MCP OAuth ${stage}`,
    metadata: {
      scopeType: context.server.scope_type,
      ...metadata
    }
  });
}

export async function prepareMcpOAuthConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  setNoStore(res);
  if (!requireOAuthEnabled(res)) return;
  try {
    const context = await requireConnectionServer(req, res, true);
    if (!context || !requireOAuthContext(context, res)) return;
    const body = requestBody(req);
    if (!hasOnlyFields(body, ['returnPath']) || !safeReturnPath(body.returnPath)) {
      res.status(400).json({
        error: {
          code: 'MCP_OAUTH_PREPARE_INVALID',
          message: 'A safe console return path is required.',
          retryable: false
        }
      });
      return;
    }
    const browserBindingHash = getOrCreateMcpOAuthBrowserBinding(req, res);
    const prepared = await prepareMcpOAuth({
      workspaceId: context.workspaceId,
      serverId: context.server.id,
      ownerId: context.ownerId,
      browserBindingHash,
      returnPath: body.returnPath,
      membershipGeneration: context.membershipGeneration!
    });
    if (!HANDLE_PATTERN.test(prepared.preparation_handle)) {
      throw new Error('MCP OAuth prepare returned an invalid correlation handle');
    }
    await recordMcpOAuthPreparationCorrelation({
      preparationHandle: prepared.preparation_handle,
      workspaceId: context.workspaceId,
      userId: context.ownerId,
      serverId: context.server.id,
      returnPath: body.returnPath,
      membershipGeneration: context.membershipGeneration!
    });
    await auditOAuth(req, context, 'prepared', {
      authorizationServerCount: prepared.candidates.length,
      registrationMethods: [...new Set(
        prepared.candidates.map((candidate) => candidate.registration_method)
      )],
      requestedScopeCount: Math.max(
        0,
        ...prepared.candidates.map((candidate) => candidate.scopes.length)
      ),
      offlineAccessRequested: prepared.candidates.some(
        (candidate) => candidate.offline_access_requested
      )
    });
    res.status(200).json({
      preparationHandle: prepared.preparation_handle,
      resourceOrigin: prepared.resource_origin,
      issuerSelectionRequired: prepared.issuer_selection_required,
      candidates: prepared.candidates.map((candidate) => ({
        issuer: candidate.issuer,
        issuerOrigin: candidate.issuer_origin,
        registrationMethod: candidate.registration_method,
        scopes: candidate.scopes,
        offlineAccessRequested: candidate.offline_access_requested
      }))
    });
  } catch (err) {
    forwardOAuthGatewayError(err, res, next);
  }
}

export async function startMcpOAuthConnection(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  setNoStore(res);
  if (!requireOAuthEnabled(res)) return;
  try {
    const context = await requireConnectionServer(req, res, true);
    if (!context || !requireOAuthContext(context, res)) return;
    const body = requestBody(req);
    const issuer = body.issuer;
    if (
      !hasOnlyFields(body, ['preparationHandle', 'issuer', 'consentGranted'])
      || typeof body.preparationHandle !== 'string'
      || !HANDLE_PATTERN.test(body.preparationHandle)
      || (issuer !== undefined && (typeof issuer !== 'string' || issuer.length > 2048))
      || body.consentGranted !== true
    ) {
      res.status(400).json({
        error: {
          code: 'MCP_OAUTH_START_INVALID',
          message: 'Valid preparation, issuer selection, and explicit consent are required.',
          retryable: false
        }
      });
      return;
    }
    const browserBindingHash = mcpOAuthBrowserBindingHash(req);
    if (!browserBindingHash) {
      res.status(400).json({
        error: {
          code: 'MCP_OAUTH_BROWSER_BINDING_REQUIRED',
          message: 'Prepare authorization again in this browser.',
          retryable: false
        }
      });
      return;
    }
    const preparationCorrelation = await getMcpOAuthPreparationCorrelation({
      preparationHandle: body.preparationHandle,
      workspaceId: context.workspaceId,
      userId: context.ownerId,
      serverId: context.server.id,
      membershipGeneration: context.membershipGeneration!
    });
    if (!preparationCorrelation) {
      res.status(409).json({
        error: {
          code: 'MCP_OAUTH_PREPARATION_STALE',
          message: 'Prepare authorization again before continuing.',
          retryable: false
        }
      });
      return;
    }
    const started = await startMcpOAuth({
      workspaceId: context.workspaceId,
      serverId: context.server.id,
      ownerId: context.ownerId,
      browserBindingHash,
      preparationHandle: body.preparationHandle,
      issuer: typeof issuer === 'string' ? issuer : undefined,
      consentGranted: true,
      membershipGeneration: context.membershipGeneration!
    });
    if (!STATE_PATTERN.test(started.state)) {
      throw new Error('MCP OAuth start returned an invalid state correlation');
    }
    await recordMcpOAuthStateCorrelation({
      state: started.state,
      workspaceId: context.workspaceId,
      userId: context.ownerId,
      serverId: context.server.id,
      returnPath: preparationCorrelation.returnPath,
      membershipGeneration: context.membershipGeneration!
    });
    try {
      await deleteMcpOAuthPreparationCorrelation(body.preparationHandle);
    } catch (cleanupError) {
      logger.warn(
        { exceptionType: cleanupError instanceof Error ? cleanupError.name : 'unknown' },
        'Failed deleting consumed MCP OAuth preparation correlation'
      );
    }
    if (typeof issuer === 'string') {
      await auditOAuth(req, context, 'issuer_selected', {
        authorizationServerSelected: true
      });
    }
    if (started.metadata_changed) {
      await auditOAuth(req, context, 'metadata_changed', {
        acceptedMetadataChange: true
      });
    }
    await auditOAuth(req, context, 'started', {
      issuerSelected: typeof issuer === 'string'
    });
    res.status(200).json({ authorizationUrl: started.authorization_url });
  } catch (err) {
    forwardOAuthGatewayError(err, res, next);
  }
}

export async function requireMcpOAuthCallbackSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  setNoStore(res);
  try {
    const session = await getSessionUser(req);
    if (!session) {
      res.redirect(303, consoleRedirectUrl('/', 'MCP_OAUTH_SESSION_REQUIRED'));
      return;
    }
    req.auth = {
      userId: session.userId,
      credential: { type: 'session', sessionId: session.sessionId }
    };
    next();
  } catch (error) {
    logger.error(
      { exceptionType: error instanceof Error ? error.name : 'unknown' },
      'Failed validating MCP OAuth callback session'
    );
    res.redirect(303, consoleRedirectUrl('/', 'MCP_OAUTH_SESSION_UNAVAILABLE'));
  }
}

export function getMcpOAuthClientMetadata(_req: Request, res: Response): void {
  if (!config.MCP_OAUTH_ENABLED) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'MCP OAuth client metadata is unavailable.',
        retryable: false
      }
    });
    return;
  }
  // OAuth callbacks must use the browser session's origin. The management
  // console exposes the control-plane API through its same-origin /api route,
  // preserving host-only session and browser-binding cookies.
  const browserBase = config.MANAGEMENT_CONSOLE_BASE_URL.replace(/\/$/, '');
  const payload = {
    client_id: `${browserBase}/api/v1/mcp/oauth/client-metadata`,
    client_name: 'AcornOps',
    client_uri: browserBase,
    redirect_uris: [`${browserBase}/api/v1/mcp/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
  const canonical = JSON.stringify(payload);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', `"${createHash('sha256').update(canonical).digest('hex')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).json(payload);
}

export async function completeMcpOAuthCallback(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  setNoStore(res);
  const fallbackPath = '/';
  if (!config.MCP_OAUTH_ENABLED) {
    res.redirect(303, consoleRedirectUrl(fallbackPath, 'MCP_OAUTH_DISABLED'));
    return;
  }
  const state = queryValue(req.query.state, 256);
  const code = queryValue(req.query.code, 8192);
  const issuer = queryValue(req.query.iss, 2048);
  const providerError = queryValue(req.query.error, 256);
  const browserBindingHash = mcpOAuthBrowserBindingHash(req);
  if (
    !state
    || !STATE_PATTERN.test(state)
    || Number(Boolean(code)) + Number(Boolean(providerError)) !== 1
    || !browserBindingHash
  ) {
    res.redirect(303, consoleRedirectUrl(
      fallbackPath,
      browserBindingHash
        ? 'MCP_OAUTH_CALLBACK_INVALID'
        : 'MCP_OAUTH_BROWSER_BINDING_REQUIRED'
    ));
    return;
  }
  let correlation: McpOAuthStateCorrelation | null = null;
  try {
    const admission = await consumeCurrentMcpOAuthStateCorrelation(state, req.auth.userId);
    if (admission.status === 'missing') {
      res.redirect(303, consoleRedirectUrl(fallbackPath, 'MCP_OAUTH_CALLBACK_INVALID'));
      return;
    }
    correlation = admission.correlation;
    if (admission.status === 'stale') {
      res.redirect(303, consoleRedirectUrl(
        correlation.returnPath,
        'MCP_USER_LIFECYCLE_STALE',
        correlation.serverId
      ));
      return;
    }
    const capturedMembershipGeneration = correlation.membershipGeneration;
    const completed = await completeMcpOAuth({
      ownerId: req.auth.userId,
      browserBindingHash,
      state,
      code,
      issuer,
      providerError,
      membershipGeneration: capturedMembershipGeneration
    });
    try {
      await recordWorkspaceAuditEvent({
        workspaceId: completed.workspace_id,
        category: 'mcp',
        eventType: 'mcp.oauth_completed.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'mcp_server',
        objectId: completed.server_id,
        objectName: completed.server_id,
        summary: 'MCP OAuth completed',
        metadata: {
          status: completed.connection.status,
          registrationMethod: completed.connection.registration_method
        }
      });
    } catch (auditError) {
      logger.error(
        { exceptionType: auditError instanceof Error ? auditError.name : 'unknown' },
        'Failed recording MCP OAuth completion audit event'
      );
    }
    res.redirect(303, consoleRedirectUrl(
      completed.return_path,
      'connected',
      completed.server_id
    ));
  } catch (err) {
    const gatewayDetails = callbackErrorDetails(err);
    const details = {
      ...gatewayDetails,
      ...(correlation && !gatewayDetails.returnPath ? { returnPath: correlation.returnPath } : {}),
      ...(correlation && !gatewayDetails.workspaceId ? { workspaceId: correlation.workspaceId } : {}),
      ...(correlation && !gatewayDetails.serverId ? { serverId: correlation.serverId } : {})
    };
    if (details.workspaceId && details.serverId) {
      const authorizationDenied = details.code === 'MCP_OAUTH_AUTHORIZATION_DENIED';
      const verificationFailed = MCP_VERIFICATION_CALLBACK_CODES.has(details.code);
      try {
        await recordWorkspaceAuditEvent({
          workspaceId: details.workspaceId,
          category: 'mcp',
          eventType: authorizationDenied
            ? 'mcp.oauth_denied.v1'
            : verificationFailed
              ? 'mcp.oauth_verification_failed.v1'
              : 'mcp.oauth_completion_failed.v1',
          operation: 'write',
          actorUserId: req.auth.userId,
          objectType: 'mcp_server',
          objectId: details.serverId,
          objectName: details.serverId,
          summary: authorizationDenied
            ? 'MCP OAuth denied'
            : verificationFailed
              ? 'MCP OAuth completed; endpoint verification failed'
              : 'MCP OAuth completion failed',
          metadata: { errorCode: details.code }
        });
      } catch (auditError) {
        logger.error(
          { exceptionType: auditError instanceof Error ? auditError.name : 'unknown' },
          'Failed recording MCP OAuth callback audit event'
        );
      }
    }
    res.redirect(303, consoleRedirectUrl(
      details.returnPath ?? fallbackPath,
      details.code,
      details.serverId
    ));
  }
}
