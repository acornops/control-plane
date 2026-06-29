import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import * as agentsController from '../controllers/agents-controller.js';

export const agentsRouter = Router();
const authed = authenticatedHandler;

agentsRouter.get('/workspaces/:workspaceId/agents', requireUser, authed(agentsController.listAgents));
agentsRouter.post('/workspaces/:workspaceId/agents', requireUser, authed(agentsController.createAgent));
agentsRouter.get('/agents/:agentId', requireUser, authed(agentsController.getAgent));
agentsRouter.patch('/agents/:agentId', requireUser, authed(agentsController.updateAgent));
agentsRouter.delete('/agents/:agentId', requireUser, authed(agentsController.deleteAgent));
agentsRouter.get('/agents/:agentId/versions', requireUser, authed(agentsController.listAgentVersions));
agentsRouter.post('/agents/:agentId/versions', requireUser, authed(agentsController.createAgentVersion));
agentsRouter.post('/agents/:agentId/versions/:versionId/restore', requireUser, authed(agentsController.restoreAgentVersion));
agentsRouter.post('/agents/:agentId/test', requireUser, authed(agentsController.testAgent));
agentsRouter.get('/agents/:agentId/activity', requireUser, authed(agentsController.listAgentActivity));
agentsRouter.post('/agents/:agentId/triggers', requireUser, authed(agentsController.createAgentTrigger));
agentsRouter.patch('/agents/:agentId/triggers/:triggerId', requireUser, authed(agentsController.updateAgentTrigger));
agentsRouter.delete('/agents/:agentId/triggers/:triggerId', requireUser, authed(agentsController.deleteAgentTrigger));
