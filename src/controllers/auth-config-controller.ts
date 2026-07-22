import type { NextFunction, Request, Response } from 'express';
import { getOrSetCsrfToken } from '../auth/csrf.js';
import { config } from '../config.js';

function passwordVerificationRequired(): boolean {
  return config.PASSWORD_EMAIL_VERIFICATION_REQUIRED && !config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL;
}

export async function authConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      oidcEnabled: config.OIDC_ENABLED,
      oidcProviderName: config.OIDC_PROVIDER_NAME,
      passwordAuthEnabled: config.PASSWORD_AUTH_ENABLED,
      passwordSignupEnabled: config.PASSWORD_SIGNUP_ENABLED,
      passwordEmailVerificationRequired: passwordVerificationRequired(),
      passwordResetEnabled: config.PASSWORD_AUTH_ENABLED && config.PASSWORD_RESET_ENABLED
    });
  } catch (err) {
    next(err);
  }
}

export async function csrfToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ csrfToken: getOrSetCsrfToken(req, res) });
  } catch (err) {
    next(err);
  }
}
