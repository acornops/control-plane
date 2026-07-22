import type { NextFunction, Request, Response } from 'express';
import { recordAuthAudit } from '../auth/auth-audit.js';
import {
  consoleLogoutResultUrl,
  consumeOidcLogoutState,
  createOidcLogoutRequest,
  startOidcLogout
} from '../auth/oidc-logout.js';
import { clearSessionCookie, deleteUserSession } from '../auth/session.js';
import { config } from '../config.js';

function setLogoutHeaders(res: Response): void {
  res.set('cache-control', 'no-store');
  res.set('referrer-policy', 'no-referrer');
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    setLogoutHeaders(res);
    const sid = req.cookies?.[config.SESSION_COOKIE_NAME] as string | undefined;
    let session = null;
    try {
      session = sid ? await deleteUserSession(sid) : null;
    } finally {
      // Do not leave a usable browser cookie behind when Redis is unavailable.
      clearSessionCookie(res);
    }
    if (session?.authMethod === 'oidc') {
      let handle: string | null = null;
      try {
        handle = await createOidcLogoutRequest(session);
      } catch {
        await recordAuthAudit({
          eventType: 'auth.logout.oidc_fallback.v1',
          summary: 'OIDC logout handoff could not be stored',
          userId: session.userId,
          provider: session.oidc?.provider,
          issuer: session.oidc?.issuer,
          reason: 'handoff_storage_error'
        });
        res.status(200).json({ status: 'ok', mode: 'local', redirectPath: '/?logout_result=local_only' });
        return;
      }
      if (handle) {
        await recordAuthAudit({
          eventType: 'auth.logout.oidc_started.v1',
          summary: 'OIDC logout handoff created',
          userId: session.userId,
          provider: session.oidc?.provider,
          issuer: session.oidc?.issuer
        });
        res.status(200).json({
          status: 'ok',
          mode: 'oidc',
          redirectPath: `/api/v1/auth/oidc/logout/start?request=${encodeURIComponent(handle)}`
        });
        return;
      }
    }
    await recordAuthAudit({
      eventType: 'auth.logout.local.v1',
      summary: 'Local browser session logout completed',
      userId: session?.userId,
      reason: session ? session.authMethod : 'no_active_session'
    });
    res.status(200).json({ status: 'ok', mode: 'local', redirectPath: '/?logout_result=success' });
  } catch (err) {
    next(err);
  }
}

export async function oidcLogoutStart(req: Request, res: Response): Promise<void> {
  setLogoutHeaders(res);
  try {
    const result = await startOidcLogout(typeof req.query.request === 'string' ? req.query.request : '');
    if (!result) {
      await recordAuthAudit({
        eventType: 'auth.logout.oidc_fallback.v1',
        summary: 'OIDC provider logout unavailable',
        reason: 'provider_logout_unavailable'
      });
      res.redirect(303, consoleLogoutResultUrl('local_only'));
      return;
    }
    res.redirect(303, result.providerUrl);
  } catch {
    await recordAuthAudit({
      eventType: 'auth.logout.oidc_fallback.v1',
      summary: 'OIDC provider logout failed before redirect',
      reason: 'provider_logout_error'
    });
    res.redirect(303, consoleLogoutResultUrl('local_only'));
  }
}

export async function oidcLogoutCallback(req: Request, res: Response): Promise<void> {
  setLogoutHeaders(res);
  let state;
  try {
    state = await consumeOidcLogoutState(typeof req.query.state === 'string' ? req.query.state : '');
  } catch {
    await recordAuthAudit({
      eventType: 'auth.logout.oidc_fallback.v1',
      summary: 'OIDC logout callback state could not be consumed',
      reason: 'callback_state_storage_error'
    });
    res.redirect(303, consoleLogoutResultUrl('incomplete'));
    return;
  }
  if (!state) {
    await recordAuthAudit({
      eventType: 'auth.logout.oidc_fallback.v1',
      summary: 'OIDC logout callback state was invalid or expired',
      reason: 'callback_state_invalid'
    });
    res.redirect(303, consoleLogoutResultUrl('incomplete'));
    return;
  }
  await recordAuthAudit({
    eventType: 'auth.logout.oidc_completed.v1',
    summary: 'OIDC provider logout callback completed',
    userId: state.userId,
    provider: state.provider,
    issuer: state.issuer
  });
  res.redirect(303, consoleLogoutResultUrl('success'));
}
