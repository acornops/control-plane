import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as webhooksController from '../controllers/webhooks-controller.js';
import { createWebhookSubscriptionSchema, updateWebhookSubscriptionSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const webhooksRouter = Router();
const authed = authenticatedHandler;

webhooksRouter.get('/workspaces/:workspaceId/webhooks', requireActor(['user']), authed(webhooksController.listWebhooks));
webhooksRouter.post(
  '/workspaces/:workspaceId/webhooks',
  requireActor(['user']),
  validateBody(createWebhookSubscriptionSchema),
  authed(webhooksController.createWebhook)
);
webhooksRouter.get('/workspaces/:workspaceId/webhooks/:webhookId', requireActor(['user']), authed(webhooksController.getWebhook));
webhooksRouter.patch(
  '/workspaces/:workspaceId/webhooks/:webhookId',
  requireActor(['user']),
  validateBody(updateWebhookSubscriptionSchema),
  authed(webhooksController.updateWebhook)
);
webhooksRouter.delete('/workspaces/:workspaceId/webhooks/:webhookId', requireActor(['user']), authed(webhooksController.deleteWebhook));
webhooksRouter.get(
  '/workspaces/:workspaceId/webhooks/:webhookId/history',
  requireActor(['user']),
  authed(webhooksController.listWebhookHistory)
);
