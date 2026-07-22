import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createConsoleExternalIntegrationLinkStatusUrl,
  createConsoleExternalIntegrationLinkUrl,
  hashExternalIntegrationLinkToken
} from '../auth/external-integration-link.js';
import { requestIp } from '../auth/client-ip.js';
import { recordAuthAudit } from '../auth/auth-audit.js';
import { evaluateOidcAdmission } from '../auth/oidc-admission.js';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import {
  buildAuthorizationUrl,
  buildIntegrationLinkAuthorizationUrl,
  buildLinkAuthorizationUrl,
  exchangeCodeForUser
} from '../auth/oidc.js';
import {
  clearOidcBrowserTransactionCookie,
  createOidcBrowserTransaction,
  oidcBrowserBindingHash,
  setOidcBrowserTransactionCookie
} from '../auth/oidc-transaction.js';
import { verifyPassword } from '../auth/password.js';
import { clearPasswordLoginAttempts, registerPasswordLoginAttempt } from '../auth/password-rate-limit.js';
import { clearSessionCookie, createUserSession, getSessionUser, replaceUserSession, setSessionCookie } from '../auth/session.js';
import { config } from '../config.js';
import { repo } from '../store/repository.js';

const oidcLinkStartSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  returnTo: z.string().max(2048).optional()
});

function handleOidcError(err: unknown, res: Response, next: NextFunction): void {
  const message = err instanceof Error ? err.message : 'OIDC authentication failed';
  if (message.includes('OIDC request timed out')) {
    res.status(504).json({
      error: { code: 'OIDC_TIMEOUT', message: 'OIDC provider request timed out', retryable: true }
    });
    return;
  }
  if (message === 'Invalid OIDC redirect_uri') {
    res.status(400).json({
      error: { code: 'INVALID_REDIRECT_URI', message: 'Invalid OIDC redirect_uri', retryable: false }
    });
    return;
  }
  next(err);
}

function rejectDisabledOidc(res: Response): boolean {
  if (config.OIDC_ENABLED) return false;
  res.status(404).json({
    error: { code: 'OIDC_NOT_CONFIGURED', message: 'OIDC authentication is not configured', retryable: false }
  });
  return true;
}

export function requireOidcConfigured(_req: Request, res: Response, next: NextFunction): void {
  if (rejectDisabledOidc(res)) return;
  next();
}

function oidcAdmissionDeniedUrl(): string {
  const url = new URL('/', config.MANAGEMENT_CONSOLE_BASE_URL);
  url.searchParams.set('auth_result', 'oidc_access_denied');
  return url.toString();
}

export async function oidcLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (rejectDisabledOidc(res)) return;
    const redirectUri = String(req.query.redirect_uri || config.OIDC_REDIRECT_URI);
    const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : undefined;
    const externalIntegrationLinkToken = typeof req.query.external_integration_link_token === 'string'
      ? req.query.external_integration_link_token
      : undefined;
    let effectiveReturnTo = returnTo;
    if (externalIntegrationLinkToken) {
      const tokenHash = hashExternalIntegrationLinkToken(externalIntegrationLinkToken);
      if (!await repo.externalIntegrationLinkTokenIsPending(tokenHash)) {
        res.redirect(createConsoleExternalIntegrationLinkStatusUrl('expired'));
        return;
      }
      effectiveReturnTo = returnTo || createConsoleExternalIntegrationLinkUrl(externalIntegrationLinkToken);
    }
    const transaction = createOidcBrowserTransaction();
    const url = externalIntegrationLinkToken
      ? await buildIntegrationLinkAuthorizationUrl(redirectUri, transaction.bindingHash, effectiveReturnTo)
      : await buildAuthorizationUrl(redirectUri, transaction.bindingHash, effectiveReturnTo);
    setOidcBrowserTransactionCookie(res, transaction.cookieValue);
    res.redirect(url);
  } catch (err) {
    handleOidcError(err, res, next);
  }
}

export async function oidcCallback(req: Request, res: Response, next: NextFunction,
  exchange: typeof exchangeCodeForUser = exchangeCodeForUser): Promise<void> {
  try {
    if (rejectDisabledOidc(res)) return;
    const browserBindingHash = oidcBrowserBindingHash(req);
    clearOidcBrowserTransactionCookie(res);
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'code and state are required', retryable: false }
      });
      return;
    }

    const authResult = await exchange(state, code, browserBindingHash);
    const userInfo = authResult.userInfo;
    const admission = evaluateOidcAdmission({
      policy: config.OIDC_ADMISSION_POLICY,
      idTokenClaims: authResult.idTokenClaims,
      userInfoClaims: authResult.userInfoClaims
    });
    if (!admission.allowed) {
      await recordAuthAudit({
        eventType: 'auth.oidc.admission.denied.v1',
        summary: 'OIDC identity denied by admission policy',
        provider: config.OIDC_PROVIDER_NAME,
        issuer: authResult.issuer,
        userId: authResult.linkUserId,
        subject: userInfo.sub,
        reason: admission.reason
      });
      res.redirect(303, oidcAdmissionDeniedUrl());
      return;
    }
    await recordAuthAudit({
      eventType: 'auth.oidc.admission.allowed.v1',
      summary: 'OIDC identity passed admission policy',
      provider: config.OIDC_PROVIDER_NAME,
      issuer: authResult.issuer,
      userId: authResult.linkUserId,
      subject: userInfo.sub,
      reason: admission.reason
    });
    const email = userInfo.email?.trim().toLowerCase();
    const displayName = userInfo.name || userInfo.preferred_username || email;

    if (authResult.purpose === 'link') {
      const currentSessionId = req.cookies?.[config.SESSION_COOKIE_NAME] as string | undefined;
      const initiatingSession = await getSessionUser(req);
      if (
        !authResult.linkUserId
        || !authResult.linkSessionId
        || currentSessionId !== authResult.linkSessionId
        || initiatingSession?.sessionId !== authResult.linkSessionId
        || initiatingSession.userId !== authResult.linkUserId
      ) {
        res.status(400).json({ error: { code: 'INVALID_OIDC_STATE', message: 'OIDC link state is invalid', retryable: false } });
        return;
      }
      if (!email) {
        res.status(400).json({ error: { code: 'OIDC_EMAIL_REQUIRED', message: 'OIDC account email is required', retryable: false } });
        return;
      }
      const linkTargetMethods = await repo.getAuthMethodsForUser(authResult.linkUserId);
      if (!linkTargetMethods.capabilities.canLinkOidc) {
        const existingIdentity = await repo.getFederatedIdentityByProviderSubject(config.OIDC_PROVIDER_NAME, userInfo.sub);
        if (existingIdentity?.user.id === authResult.linkUserId) {
          const sessionId = await replaceUserSession(authResult.linkSessionId, authResult.linkUserId, {
            authMethod: 'oidc', provider: config.OIDC_PROVIDER_NAME, issuer: authResult.issuer, idToken: authResult.idToken
          });
          if (!sessionId) {
            clearSessionCookie(res);
            res.status(401).json({ error: { code: 'OIDC_LINK_SESSION_EXPIRED', message: 'The initiating session is no longer active', retryable: false } });
            return;
          }
          setSessionCookie(res, sessionId);
          res.redirect(authResult.returnTo || '/settings');
          return;
        }
        res.status(409).json({ error: { code: 'OIDC_ALREADY_LINKED', message: 'This account already has SSO connected', retryable: false } });
        return;
      }
      const linkResult = await repo.linkFederatedIdentity({
        userId: authResult.linkUserId,
        provider: config.OIDC_PROVIDER_NAME,
        subject: userInfo.sub,
        emailAtLinkTime: email,
        emailVerified: userInfo.email_verified
      });
      if (linkResult.status === 'linked_to_other_user') {
        res.status(409).json({ error: { code: 'OIDC_IDENTITY_ALREADY_LINKED', message: 'OIDC identity is already linked to another user', retryable: false } });
        return;
      }
      const sessionId = await replaceUserSession(authResult.linkSessionId, authResult.linkUserId, {
        authMethod: 'oidc', provider: config.OIDC_PROVIDER_NAME, issuer: authResult.issuer, idToken: authResult.idToken
      });
      if (!sessionId) {
        clearSessionCookie(res);
        res.status(401).json({ error: { code: 'OIDC_LINK_SESSION_EXPIRED', message: 'The initiating session is no longer active', retryable: false } });
        return;
      }
      setSessionCookie(res, sessionId);
      res.redirect(authResult.returnTo || '/settings');
      return;
    }

    const loginResult = await repo.resolveOidcLogin({
      provider: config.OIDC_PROVIDER_NAME,
      subject: userInfo.sub,
      email,
      displayName: displayName || email || userInfo.sub,
      emailVerified: userInfo.email_verified
    });
    if (loginResult.status === 'account_link_required') {
      res.status(409).json({ error: { code: 'ACCOUNT_LINK_REQUIRED', message: 'An account with this email already exists; use its existing sign-in method', retryable: false } });
      return;
    }
    if (loginResult.status === 'email_required') {
      res.status(400).json({ error: { code: 'OIDC_EMAIL_REQUIRED', message: 'OIDC account email is required', retryable: false } });
      return;
    }
    const user = loginResult.user;
    const sessionId = await createUserSession(user.id, {
      authMethod: 'oidc', provider: config.OIDC_PROVIDER_NAME, issuer: authResult.issuer, idToken: authResult.idToken
    });
    setSessionCookie(res, sessionId);

    if (authResult.returnTo) {
      res.redirect(authResult.returnTo);
      return;
    }
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function oidcLinkStart(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (rejectDisabledOidc(res)) return;
    const parsed = oidcLinkStartSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'currentPassword is required', retryable: false } });
      return;
    }

    const credential = await repo.getPasswordCredentialByUserId(req.auth.userId);
    if (!credential) {
      res.status(403).json({ error: { code: 'PASSWORD_AUTH_NOT_CONFIGURED', message: 'Only password-backed accounts can connect SSO', retryable: false } });
      return;
    }
    const methods = await repo.getAuthMethodsForUser(req.auth.userId);
    if (!methods.capabilities.canLinkOidc) {
      res.status(409).json({ error: { code: 'OIDC_ALREADY_LINKED', message: 'This account already has SSO connected', retryable: false } });
      return;
    }

    const ipAddress = requestIp(req);
    const allowed = await registerPasswordLoginAttempt(`link:${req.auth.userId}`, ipAddress);
    if (!allowed) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many SSO link attempts. Try again later.', retryable: true } });
      return;
    }

    if (!(await verifyPassword(parsed.data.currentPassword, credential.password_hash))) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect', retryable: false } });
      return;
    }

    if (req.auth.credential.type !== 'session') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User session required', retryable: false } });
      return;
    }

    await clearPasswordLoginAttempts(`link:${req.auth.userId}`, ipAddress);
    const transaction = createOidcBrowserTransaction();
    const url = await buildLinkAuthorizationUrl(
      req.auth.userId,
      req.auth.credential.sessionId,
      config.OIDC_REDIRECT_URI,
      transaction.bindingHash,
      parsed.data.returnTo
    );
    setOidcBrowserTransactionCookie(res, transaction.cookieValue);
    res.status(200).json({ url });
  } catch (err) {
    handleOidcError(err, res, next);
  }
}
