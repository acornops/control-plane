import { NextFunction, Request, Response } from 'express';
import { buildAdminAuthorizationUrl, exchangeAdminAuthorizationCode } from '../auth/admin-oidc.js';
import { adminOidcFailure } from '../auth/admin-oidc-errors.js';
import { clearAdminCsrfCookie, getOrSetAdminCsrfToken } from '../auth/admin-csrf.js';
import { adminSessionReference, clearAdminSessionCookie, createAdminSession, deleteAdminSession, getAdminSession, setAdminSessionCookie } from '../auth/admin-session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementAdminAuditWriteFailures, incrementAdminAuthFailures } from '../metrics.js';
import { repo } from '../store/repository.js';

function requestId(res: Response): string { return String(res.locals.requestId || ''); }
function redirectTarget(path: string): string { return new URL(path, config.PLATFORM_ADMIN_CONSOLE_BASE_URL).toString(); }

async function auditAuth(req: Request, res: Response, input: { action: string; outcome: 'success' | 'failure'; issuer?: string; subject?: string; email?: string; displayName?: string; role?: string; sessionReference?: string; authenticatedAt?: number; reason?: string }): Promise<void> {
  try {
    const event = await repo.insertAdminAuditEvent({
      action: input.action,
      outcome: input.outcome,
      requestId: requestId(res),
      sourceIp: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.header('user-agent') || null,
      reason: input.reason || null,
      adminActorIssuer: input.issuer || null,
      adminActorSubject: input.subject || null,
      adminActorEmail: input.email || null,
      adminActorDisplayName: input.displayName || null,
      adminActorRole: input.role || null,
      adminSessionIdHash: input.sessionReference || null,
      authenticationTime: input.authenticatedAt ? new Date(input.authenticatedAt).toISOString() : null,
      metadata: {}
    });
    logger.info({ securityEvent: 'platform_admin_auth', auditEventId: event.id, action: event.action, outcome: event.outcome, actorIssuer: event.adminActorIssuer || null, actorSubject: event.adminActorSubject || null, requestId: event.requestId }, 'Platform admin authentication audit event persisted');
  } catch (err) {
    incrementAdminAuditWriteFailures();
    throw err;
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : '/';
    const reauthenticate = req.query.reauthenticate === 'true';
    res.redirect(await buildAdminAuthorizationUrl(returnTo, reauthenticate));
  } catch (err) {
    const failure = adminOidcFailure(err);
    incrementAdminAuthFailures(failure.reason.toLowerCase());
    logger.warn({ code: failure.reason, requestId: requestId(res) }, 'Platform admin login could not start');
    await auditAuth(req, res, { action: 'admin.auth.login.failure', outcome: 'failure', reason: failure.reason }).catch(() => undefined);
    res.status(failure.status).json({ error: { ...failure.error, request_id: requestId(res) } });
  }
}

export async function callback(req: Request, res: Response, next: NextFunction): Promise<void> {
  let sessionId: string | undefined;
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'code and state are required', retryable: false } }); return; }
    const result = await exchangeAdminAuthorizationCode(state, code);
    const previousSessionId = req.cookies?.[config.ADMIN_SESSION_COOKIE_NAME] as string | undefined;
    if (previousSessionId) await deleteAdminSession(previousSessionId);
    sessionId = await createAdminSession(result.identity);
    await auditAuth(req, res, {
      action: 'admin.auth.login.success', outcome: 'success', issuer: result.identity.issuer, subject: result.identity.subject,
      email: result.identity.email, displayName: result.identity.displayName, role: result.identity.roles[0],
      sessionReference: adminSessionReference(sessionId), authenticatedAt: result.identity.authenticatedAt
    });
    setAdminSessionCookie(res, sessionId);
    res.redirect(redirectTarget(result.returnTo));
  } catch (err) {
    if (sessionId) await deleteAdminSession(sessionId).catch(() => undefined);
    clearAdminSessionCookie(res);
    const failure = adminOidcFailure(err);
    incrementAdminAuthFailures(failure.reason.toLowerCase());
    logger.warn({ code: failure.reason, requestId: requestId(res) }, 'Platform admin login failed');
    await auditAuth(req, res, { action: 'admin.auth.login.failure', outcome: 'failure', reason: failure.reason }).catch(() => undefined);
    res.status(failure.status).json({ error: { ...failure.error, request_id: requestId(res) } });
  }
}

export function csrf(req: Request, res: Response): void {
  res.status(200).json({ csrfToken: getOrSetAdminCsrfToken(req, res) });
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.[config.ADMIN_SESSION_COOKIE_NAME] as string | undefined;
    const session = await getAdminSession(req);
    if (session) {
      await auditAuth(req, res, { action: 'admin.auth.logout', outcome: 'success', issuer: session.issuer, subject: session.subject, email: session.email, displayName: session.displayName, role: session.roles[0], sessionReference: adminSessionReference(session.id), authenticatedAt: session.authenticatedAt })
        .catch((err) => logger.warn({ err, requestId: requestId(res) }, 'Failed recording platform admin logout'));
    }
    if (sessionId) await deleteAdminSession(sessionId);
    clearAdminSessionCookie(res);
    clearAdminCsrfCookie(res);
    res.status(200).json({ status: 'ok' });
  } catch (err) { next(err); }
}
