import { Router } from 'express';
import { config } from '../config.js';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import * as authController from '../controllers/auth-controller.js';
import * as emailVerificationController from '../controllers/email-verification-controller.js';
import * as passwordResetController from '../controllers/password-reset-controller.js';

export const authRouter = Router();
const authed = authenticatedHandler;

authRouter.get('/auth/config', authController.authConfig);
authRouter.get('/auth/csrf', authController.csrfToken);
authRouter.get('/auth/oidc/login', authController.oidcLogin);
authRouter.get('/auth/oidc/callback', authController.oidcCallback);
authRouter.post('/auth/oidc/link/start', requireUser, authed(authController.oidcLinkStart));
authRouter.post('/auth/password/login', authController.passwordLogin);
authRouter.post('/auth/password/signup', authController.passwordSignup);
authRouter.post('/auth/password/verify-email', emailVerificationController.verifyPasswordEmail);
authRouter.post('/auth/password/resend-verification', emailVerificationController.resendPasswordVerification);
authRouter.post('/auth/password/forgot', passwordResetController.requestPasswordReset);
authRouter.post('/auth/password/reset', passwordResetController.resetPassword);
authRouter.post('/auth/password/change', requireUser, authed(authController.passwordChange));
authRouter.post('/auth/logout', authController.logout);

if (config.NODE_ENV !== 'production') {
  authRouter.post('/auth/dev-login', authController.devLogin);
}

authRouter.get('/me', requireUser, authed(authController.me));
authRouter.get('/auth/methods', requireUser, authed(authController.authMethods));
authRouter.get('/auth/jwks.json', authController.jwks);
