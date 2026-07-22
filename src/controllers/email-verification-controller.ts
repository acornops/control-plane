import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requestIp } from '../auth/client-ip.js';
import { generateEmailVerificationToken, hashEmailVerificationToken, isPlausibleAuthEmailToken } from '../auth/password.js';
import { registerPasswordLoginAttempt } from '../auth/password-rate-limit.js';
import { createUserSession, setSessionCookie } from '../auth/session.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendVerificationEmail } from '../services/email-delivery.js';
import { repo } from '../store/repository.js';

const verifyEmailSchema = z.object({
  token: z.string().trim().min(1).max(512)
});

const resendVerificationSchema = z.object({
  email: z.string().trim().email().max(320)
});

function verificationExpiry(): Date {
  return new Date(Date.now() + config.PASSWORD_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS * 1000);
}

function invalidVerificationToken(res: Response): void {
  res.status(400).json({
    error: {
      code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
      message: 'This verification link is no longer valid.',
      retryable: false
    }
  });
}

export async function verifyPasswordEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = verifyEmailSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Verification token is required', retryable: false } });
      return;
    }

    if (!isPlausibleAuthEmailToken(parsed.data.token)) {
      invalidVerificationToken(res);
      return;
    }

    const result = await repo.consumeEmailVerificationToken(hashEmailVerificationToken(parsed.data.token));
    if (result.status === 'invalid') {
      invalidVerificationToken(res);
      return;
    }
    if (result.status === 'expired') {
      res.status(410).json({
        error: {
          code: 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
          message: 'This verification link expired. Request a new one to continue.',
          retryable: true
        }
      });
      return;
    }

    const sessionId = await createUserSession(result.user.id, { authMethod: 'password' });
    setSessionCookie(res, sessionId);
    res.status(200).json({ user: result.user, mode: 'password', status: 'verified' });
  } catch (err) {
    next(err);
  }
}

export async function resendPasswordVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = resendVerificationSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid email is required', retryable: false } });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const allowed = await registerPasswordLoginAttempt(`verify:${email}`, requestIp(req));
    if (!allowed) {
      res.status(200).json({
        status: 'ok',
        message: 'If an account is pending verification, a verification email will be sent.',
        resendAfterSeconds: config.PASSWORD_AUTH_RATE_LIMIT_WINDOW_SECONDS
      });
      return;
    }

    const token = generateEmailVerificationToken();
    const tokenHash = hashEmailVerificationToken(token);
    const expiresAt = verificationExpiry();
    const result = await repo.prepareEmailVerificationResend({
      email,
      tokenHash,
      expiresAt,
      resendWindowSeconds: config.PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS
    });

    if (result.status === 'throttled') {
      res.status(200).json({
        status: 'ok',
        message: 'If an account is pending verification, a verification email will be sent.',
        resendAfterSeconds: result.resendAfterSeconds
      });
      return;
    }
    if (result.status === 'rotated') {
      try {
        const delivery = await sendVerificationEmail({ email, token, expiresAt });
        if (delivery.status !== 'sent') throw new Error('Email delivery skipped');
      } catch {
        await repo.invalidateEmailVerificationToken(tokenHash).catch((err) => {
          logger.warn({ err, email }, 'Failed invalidating undelivered verification token');
        });
        res.status(200).json({
          status: 'ok',
          message: 'If an account is pending verification, a verification email will be sent.'
        });
        return;
      }
      await repo.retireOtherEmailVerificationTokens(tokenHash);
    }

    res.status(200).json({
      status: 'ok',
      message: 'If an account is pending verification, a verification email will be sent.',
      resendAfterSeconds: result.status === 'rotated'
        ? config.PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS
        : undefined
    });
  } catch (err) {
    next(err);
  }
}
