import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requestIp } from '../auth/client-ip.js';
import {
  generateAuthEmailToken,
  hashAuthEmailToken,
  hashPassword,
  isPlausibleAuthEmailToken,
  validatePasswordPolicy
} from '../auth/password.js';
import { registerPasswordResetRequest } from '../auth/password-rate-limit.js';
import { clearSessionCookie, revokeUserSessions } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendPasswordResetEmail } from '../services/email-delivery.js';
import { repo } from '../store/repository.js';

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(320)
});

const resetPasswordSchema = z.object({
  token: z.unknown().optional(),
  password: z.string().min(1).max(1024)
});

const GENERIC_RESET_MESSAGE = 'If a password-backed account exists, reset instructions will be sent.';

function resetExpiry(): Date {
  return new Date(Date.now() + config.PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
}

function passwordResetDisabled(res: Response): void {
  res.status(403).json({
    error: { code: 'PASSWORD_RESET_DISABLED', message: 'Password reset is disabled', retryable: false }
  });
}

function invalidResetToken(res: Response): void {
  res.status(400).json({
    error: {
      code: 'PASSWORD_RESET_TOKEN_INVALID',
      message: 'This reset link is no longer valid.',
      retryable: false
    }
  });
}

function expiredResetToken(res: Response): void {
  res.status(410).json({
    error: {
      code: 'PASSWORD_RESET_TOKEN_EXPIRED',
      message: 'This reset link expired. Request a new one to continue.',
      retryable: true
    }
  });
}

export async function requestPasswordReset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.PASSWORD_AUTH_ENABLED || !config.PASSWORD_RESET_ENABLED) {
      passwordResetDisabled(res);
      return;
    }

    const parsed = forgotPasswordSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid email is required', retryable: false } });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const allowed = await registerPasswordResetRequest(email, requestIp(req));
    if (!allowed) {
      res.status(200).json({
        status: 'ok',
        message: GENERIC_RESET_MESSAGE,
        resendAfterSeconds: config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS
      });
      return;
    }

    const token = generateAuthEmailToken();
    const tokenHash = hashAuthEmailToken(token);
    const expiresAt = resetExpiry();
    const result = await repo.preparePasswordResetRequest({
      email,
      tokenHash,
      expiresAt,
      requestWindowSeconds: config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS
    });

    if (result.status === 'rotated') {
      try {
        const delivery = await sendPasswordResetEmail({ email, token, expiresAt });
        if (delivery.status !== 'sent') throw new Error('Email delivery skipped');
      } catch {
        await repo.invalidatePasswordResetToken(tokenHash).catch((err) => {
          logger.warn({ err, email }, 'Failed invalidating undelivered password reset token');
        });
      }
    }

    res.status(200).json({
      status: 'ok',
      message: GENERIC_RESET_MESSAGE,
      resendAfterSeconds: result.status === 'throttled'
        ? result.resendAfterSeconds
        : config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS
    });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.PASSWORD_AUTH_ENABLED || !config.PASSWORD_RESET_ENABLED) {
      passwordResetDisabled(res);
      return;
    }

    const parsed = resetPasswordSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'token and password are required', retryable: false } });
      return;
    }

    const token = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : '';
    if (!isPlausibleAuthEmailToken(token)) {
      invalidResetToken(res);
      return;
    }

    const tokenHash = hashAuthEmailToken(token);
    const context = await repo.getPasswordResetTokenContext(tokenHash);
    if (context.status === 'invalid') {
      invalidResetToken(res);
      return;
    }
    if (context.status === 'expired') {
      expiredResetToken(res);
      return;
    }

    const passwordPolicy = validatePasswordPolicy(parsed.data.password, {
      email: context.user.email,
      username: context.username,
      displayName: context.user.displayName
    });
    if (!passwordPolicy.valid) {
      res.status(400).json({ error: { code: 'PASSWORD_POLICY_VIOLATION', message: passwordPolicy.message, retryable: false } });
      return;
    }

    const result = await repo.consumePasswordResetToken({
      tokenHash,
      passwordHash: await hashPassword(parsed.data.password)
    });
    if (result.status === 'invalid') {
      invalidResetToken(res);
      return;
    }
    if (result.status === 'expired') {
      expiredResetToken(res);
      return;
    }

    await revokeUserSessions(result.user.id);
    clearSessionCookie(res);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
}
