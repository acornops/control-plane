import type { NextFunction, Request, Response } from 'express';
import { getOrSetCsrfToken } from '../auth/csrf.js';
import { config } from '../config.js';
import {
  oidcSignInEnabled,
  passwordSignInEnabled,
  passwordSignupEnabled
} from '../services/platform-settings.js';

function passwordVerificationRequired(): boolean {
  return config.PASSWORD_EMAIL_VERIFICATION_REQUIRED && !config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL;
}

export async function authConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({
      oidcEnabled: oidcSignInEnabled(),
      oidcProviderName: config.OIDC_PROVIDER_NAME,
      passwordAuthEnabled: passwordSignInEnabled(),
      passwordSignupEnabled: passwordSignupEnabled(),
      passwordEmailVerificationRequired: passwordVerificationRequired(),
      passwordResetEnabled: passwordSignInEnabled() && config.PASSWORD_RESET_ENABLED
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
