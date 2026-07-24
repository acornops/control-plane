import { Router } from 'express';
import { authenticatedHandler, requireLinkedExternalIntegration, requireUser } from '../auth/middleware.js';
import * as externalWebhookRouteController from '../controllers/external-webhook-route-controller.js';
import * as webhooksController from '../controllers/webhooks-controller.js';
import { createWebhookSubscriptionSchema, updateWebhookSubscriptionSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const webhooksRouter = Router();
const authed = authenticatedHandler;

webhooksRouter.post('/external-integrations/webhook-routes/connect', requireLinkedExternalIntegration, authed(externalWebhookRouteController.connectExternalWebhookRoute));
webhooksRouter.get('/external-integrations/webhook-routes/status', requireLinkedExternalIntegration, authed(externalWebhookRouteController.getExternalWebhookRouteStatus));
webhooksRouter.get('/workspaces/:workspaceId/webhooks', requireUser, authed(webhooksController.listWebhooks));
webhooksRouter.post(
  '/workspaces/:workspaceId/webhooks',
  requireUser,
  validateBody(createWebhookSubscriptionSchema),
  authed(webhooksController.createWebhook)
);
webhooksRouter.get('/workspaces/:workspaceId/webhooks/:webhookId', requireUser, authed(webhooksController.getWebhook));
webhooksRouter.patch(
  '/workspaces/:workspaceId/webhooks/:webhookId',
  requireUser,
  validateBody(updateWebhookSubscriptionSchema),
  authed(webhooksController.updateWebhook)
);
webhooksRouter.delete('/workspaces/:workspaceId/webhooks/:webhookId', requireUser, authed(webhooksController.deleteWebhook));
webhooksRouter.get(
  '/workspaces/:workspaceId/webhooks/:webhookId/history',
  requireUser,
  authed(webhooksController.listWebhookHistory)
);
