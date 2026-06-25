import { Router } from 'express';
import { config } from '../config.js';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as authController from '../controllers/auth-controller.js';
import * as emailVerificationController from '../controllers/email-verification-controller.js';
import * as externalIntegrationLinkController from '../controllers/external-integration-link-controller.js';
import * as passwordResetController from '../controllers/password-reset-controller.js';

export const authRouter = Router();
const authed = authenticatedHandler;

authRouter.get('/auth/config', authController.authConfig);
authRouter.get('/auth/csrf', authController.csrfToken);
authRouter.get('/auth/oidc/login', authController.oidcLogin);
authRouter.get('/auth/oidc/callback', authController.oidcCallback);
authRouter.post('/auth/oidc/link/start', requireActor(['user']), authed(authController.oidcLinkStart));
authRouter.post('/auth/external-integrations/link/preview', requireActor(['user']), authed(externalIntegrationLinkController.previewExternalIntegrationLinkRequest));
authRouter.post('/auth/external-integrations/link/complete', requireActor(['user']), authed(externalIntegrationLinkController.completeExternalIntegrationLinkRequest));
authRouter.get('/auth/external-integrations/links', requireActor(['user']), authed(externalIntegrationLinkController.listExternalIntegrationLinks));
authRouter.post('/auth/external-integrations/links/unlink', requireActor(['user']), authed(externalIntegrationLinkController.unlinkExternalIntegrationLink));
authRouter.post(
  '/auth/external-integrations/link',
  requireActor(['externalIntegration'], { externalIntegrationMode: 'client' }),
  externalIntegrationLinkController.createExternalIntegrationLinkRequest
);
authRouter.post(
  '/auth/external-integrations/resolve',
  requireActor(['externalIntegration'], { externalIntegrationMode: 'client' }),
  externalIntegrationLinkController.resolveExternalIntegrationLink
);
authRouter.post(
  '/auth/external-integrations/revoke',
  requireActor(['externalIntegration'], { externalIntegrationMode: 'client' }),
  externalIntegrationLinkController.revokeExternalIntegrationLink
);
authRouter.post('/auth/password/login', authController.passwordLogin);
authRouter.post('/auth/password/signup', authController.passwordSignup);
authRouter.post('/auth/password/verify-email', emailVerificationController.verifyPasswordEmail);
authRouter.post('/auth/password/resend-verification', emailVerificationController.resendPasswordVerification);
authRouter.post('/auth/password/forgot', passwordResetController.requestPasswordReset);
authRouter.post('/auth/password/reset', passwordResetController.resetPassword);
authRouter.post('/auth/password/change', requireActor(['user']), authed(authController.passwordChange));
authRouter.post('/auth/logout', authController.logout);

if (config.NODE_ENV !== 'production') {
  authRouter.post('/auth/dev-login', authController.devLogin);
}

authRouter.get('/me', requireActor(['user']), authed(authController.me));
authRouter.get('/auth/methods', requireActor(['user']), authed(authController.authMethods));
authRouter.get('/auth/jwks.json', authController.jwks);
