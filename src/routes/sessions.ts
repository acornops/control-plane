import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as sessionsController from '../controllers/sessions-controller.js';
import { createSessionSchema, postMessageSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const sessionsRouter = Router();
const authed = authenticatedHandler;

sessionsRouter.post(
  '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions',
  requireActor(['user', 'externalIntegration']),
  validateBody(createSessionSchema),
  authed(sessionsController.createSession)
);
sessionsRouter.post(
  '/workspaces/:workspaceId/targets/:targetId/sessions',
  requireActor(['user', 'externalIntegration']),
  validateBody(createSessionSchema),
  authed(sessionsController.createSession)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions',
  requireActor(['user', 'externalIntegration']),
  authed(sessionsController.listSessions)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/targets/:targetId/sessions',
  requireActor(['user', 'externalIntegration']),
  authed(sessionsController.listSessions)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/targets/:targetId/chat-activity',
  requireActor(['user', 'externalIntegration']),
  authed(sessionsController.getTargetChatActivity)
);

sessionsRouter.get('/sessions/:sessionId', requireActor(['user', 'externalIntegration']), authed(sessionsController.getSession));
sessionsRouter.delete('/sessions/:sessionId', requireActor(['user']), authed(sessionsController.deleteSession));
sessionsRouter.get('/sessions/:sessionId/messages', requireActor(['user', 'externalIntegration']), authed(sessionsController.listMessages));
sessionsRouter.post('/sessions/:sessionId/messages', requireActor(['user', 'externalIntegration']), validateBody(postMessageSchema), authed(sessionsController.postMessage));
