import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import * as sessionsController from '../controllers/sessions-controller.js';
import { createSessionSchema, postMessageSchema } from '../types/contracts.js';
import { validateBody } from '../utils/http.js';

export const sessionsRouter = Router();
const authed = authenticatedHandler;

sessionsRouter.post(
  '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions',
  requireUser,
  validateBody(createSessionSchema),
  authed(sessionsController.createSession)
);
sessionsRouter.post(
  '/workspaces/:workspaceId/targets/:targetId/sessions',
  requireUser,
  validateBody(createSessionSchema),
  authed(sessionsController.createSession)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/kubernetes-clusters/:clusterId/sessions',
  requireUser,
  authed(sessionsController.listSessions)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/targets/:targetId/sessions',
  requireUser,
  authed(sessionsController.listSessions)
);
sessionsRouter.get(
  '/workspaces/:workspaceId/targets/:targetId/chat-activity',
  requireUser,
  authed(sessionsController.getTargetChatActivity)
);

sessionsRouter.get('/sessions/:sessionId', requireUser, authed(sessionsController.getSession));
sessionsRouter.delete('/sessions/:sessionId', requireUser, authed(sessionsController.deleteSession));
sessionsRouter.get('/sessions/:sessionId/messages', requireUser, authed(sessionsController.listMessages));
sessionsRouter.post('/sessions/:sessionId/messages', requireUser, validateBody(postMessageSchema), authed(sessionsController.postMessage));
