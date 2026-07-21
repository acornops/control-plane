import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requestIp } from '../auth/client-ip.js';
import { AuthenticatedRequest } from '../auth/middleware.js';
import {
  hashPassword,
  generateEmailVerificationToken,
  hashEmailVerificationToken,
  isValidUsername,
  normalizeLoginIdentifier,
  normalizeUsername,
  validatePasswordPolicy,
  verifyPassword
} from '../auth/password.js';
import { clearPasswordLoginAttempts, registerPasswordLoginAttempt } from '../auth/password-rate-limit.js';
import { createUserSession, rotateUserSessions, setSessionCookie } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendVerificationEmail } from '../services/email-delivery.js';
import { gatewayTokenService } from '../services/token-service.js';
import { repo } from '../store/repository.js';

const passwordLoginSchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(1024)
});

const passwordSignupSchema = z.object({
  email: z.string().trim().email().max(320),
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(1024),
  displayName: z.string().trim().min(1).max(120).optional()
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024)
});

function displayNameFromEmail(email: string): string {
  return email.split('@')[0] || email;
}

const passwordVerificationRequired = (): boolean => config.PASSWORD_EMAIL_VERIFICATION_REQUIRED
  && !config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL;

function verificationExpiry(): Date {
  return new Date(Date.now() + config.PASSWORD_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS * 1000);
}

export async function passwordLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.PASSWORD_AUTH_ENABLED) {
      res.status(403).json({ error: { code: 'PASSWORD_AUTH_DISABLED', message: 'Password login is disabled', retryable: false } });
      return;
    }

    const parsed = passwordLoginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'identifier and password are required', retryable: false } });
      return;
    }

    const identifier = normalizeLoginIdentifier(parsed.data.identifier);
    const ipAddress = requestIp(req);
    const allowed = await registerPasswordLoginAttempt(identifier, ipAddress);
    if (!allowed) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.', retryable: true } });
      return;
    }

    const credential = await repo.getPasswordCredentialByIdentifier(identifier);
    const passwordMatches = credential ? await verifyPassword(parsed.data.password, credential.passwordHash) : false;
    if (!credential || !passwordMatches) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password', retryable: false } });
      return;
    }
    if (credential.emailVerificationRequired && !credential.emailVerifiedAt) {
      await clearPasswordLoginAttempts(identifier, ipAddress);
      res.status(403).json({
        error: {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Verify your email before signing in.',
          retryable: false,
          details: { email: credential.user.email }
        }
      });
      return;
    }

    await clearPasswordLoginAttempts(identifier, ipAddress);
    await repo.markPasswordLoginSuccess(credential.user.id);
    const sessionId = await createUserSession(credential.user.id, { authMethod: 'password' });
    setSessionCookie(res, sessionId);
    res.status(200).json({ user: credential.user, mode: 'password' });
  } catch (err) {
    next(err);
  }
}

export async function passwordSignup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.PASSWORD_AUTH_ENABLED || !config.PASSWORD_SIGNUP_ENABLED) {
      res.status(403).json({ error: { code: 'SIGNUP_DISABLED', message: 'Password signup is disabled', retryable: false } });
      return;
    }

    const parsed = passwordSignupSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A valid email, username, and password of at least 15 characters are required',
          retryable: false
        }
      });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const username = normalizeUsername(parsed.data.username);
    if (!isValidUsername(username)) {
      res.status(400).json({
        error: {
          code: 'INVALID_USERNAME',
          message: 'Username must be 3-32 characters and use lowercase letters, numbers, dots, dashes, or underscores',
          retryable: false
        }
      });
      return;
    }

    const passwordPolicy = validatePasswordPolicy(parsed.data.password, {
      email,
      username,
      displayName: parsed.data.displayName || displayNameFromEmail(email)
    });
    if (!passwordPolicy.valid) {
      res.status(400).json({ error: { code: 'PASSWORD_POLICY_VIOLATION', message: passwordPolicy.message, retryable: false } });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const requiresVerification = passwordVerificationRequired();
    const verificationToken = requiresVerification ? generateEmailVerificationToken() : undefined;
    const verificationExpiresAt = requiresVerification ? verificationExpiry() : undefined;
    const result = await repo.createPasswordUser({
      email,
      username,
      displayName: parsed.data.displayName || displayNameFromEmail(email),
      passwordHash,
      emailVerificationRequired: requiresVerification,
      verificationTokenHash: verificationToken ? hashEmailVerificationToken(verificationToken) : undefined,
      verificationTokenExpiresAt: verificationExpiresAt
    });
    if (result.status === 'email_exists') {
      res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'An account already exists for this email', retryable: false } });
      return;
    }
    if (result.status === 'username_exists') {
      res.status(409).json({ error: { code: 'USERNAME_EXISTS', message: 'This username is already taken', retryable: false } });
      return;
    }

    if (requiresVerification && verificationToken && verificationExpiresAt) {
      const verificationTokenHash = hashEmailVerificationToken(verificationToken);
      try {
        const delivery = await sendVerificationEmail({ email, token: verificationToken, expiresAt: verificationExpiresAt });
        if (delivery.status !== 'sent') throw new Error('Email delivery skipped');
      } catch (err) {
        await repo.invalidateEmailVerificationToken(verificationTokenHash).catch((cleanupErr) => {
          logger.warn({ err: cleanupErr, email }, 'Failed invalidating undelivered signup verification token');
        });
        res.status(503).json({
          error: {
            code: 'EMAIL_DELIVERY_FAILED',
            message: 'The account was created, but the verification email could not be sent. Try resending the email.',
            retryable: true,
            details: { email }
          }
        });
        return;
      }
      res.status(201).json({
        status: 'verification_required',
        email,
        resendAfterSeconds: config.PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS
      });
      return;
    }

    const sessionId = await createUserSession(result.user.id, { authMethod: 'password' });
    setSessionCookie(res, sessionId);
    res.status(201).json({ user: result.user, mode: 'password' });
  } catch (err) {
    next(err);
  }
}

export async function passwordChange(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.PASSWORD_AUTH_ENABLED) {
      res.status(403).json({ error: { code: 'PASSWORD_AUTH_DISABLED', message: 'Password login is disabled', retryable: false } });
      return;
    }

    const parsed = passwordChangeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'currentPassword and newPassword are required', retryable: false } });
      return;
    }

    const user = await repo.getUserById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found', retryable: false } });
      return;
    }

    const credential = await repo.getPasswordCredentialByUserId(user.id);
    if (!credential) {
      res.status(403).json({ error: { code: 'PASSWORD_AUTH_NOT_CONFIGURED', message: 'This account does not have a local password', retryable: false } });
      return;
    }

    const ipAddress = requestIp(req);
    const allowed = await registerPasswordLoginAttempt(`change:${user.id}`, ipAddress);
    if (!allowed) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many password change attempts. Try again later.', retryable: true } });
      return;
    }

    if (!(await verifyPassword(parsed.data.currentPassword, credential.password_hash))) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect', retryable: false } });
      return;
    }
    await clearPasswordLoginAttempts(`change:${user.id}`, ipAddress);

    const passwordPolicy = validatePasswordPolicy(parsed.data.newPassword, {
      email: user.email,
      username: credential.username,
      displayName: user.displayName
    });
    if (!passwordPolicy.valid) {
      res.status(400).json({ error: { code: 'PASSWORD_POLICY_VIOLATION', message: passwordPolicy.message, retryable: false } });
      return;
    }

    await repo.updatePasswordCredentialHash(user.id, await hashPassword(parsed.data.newPassword));
    const sessionId = await rotateUserSessions(user.id, { authMethod: 'password' });
    setSessionCookie(res, sessionId);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
}

export async function authMethods(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await repo.getAuthMethodsForUser(req.auth.userId));
  } catch (err) {
    next(err);
  }
}

export async function devLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : 'dev@acornops.local';
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Dev User';
    const user = await repo.upsertUser(email, name);
    const sessionId = await createUserSession(user.id, { authMethod: 'dev' });
    setSessionCookie(res, sessionId);
    res.status(200).json({ user, mode: 'dev' });
  } catch (err) {
    next(err);
  }
}

export async function me(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await repo.getUserById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found', retryable: false } });
      return;
    }
    res.status(200).json({
      ...user,
      quota: await repo.getUserQuotaForUser(user.id)
    });
  } catch (err) {
    next(err);
  }
}

export async function jwks(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const keys = await gatewayTokenService.getJwks();
    res.status(200).json(keys);
  } catch (err) {
    next(err);
  }
}

export { logout, oidcLogoutCallback, oidcLogoutStart } from './oidc-logout-controller.js';
export { oidcCallback, oidcLinkStart, oidcLogin, requireOidcConfigured } from './oidc-auth-controller.js';
export { authConfig, csrfToken } from './auth-config-controller.js';
