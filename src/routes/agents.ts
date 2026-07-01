import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as agentsController from '../controllers/agents-controller.js';

export const agentsRouter = Router();
const authed = authenticatedHandler;

agentsRouter.get('/workspaces/:workspaceId/agents', requireActor(['user']), authed(agentsController.listAgents));
agentsRouter.post('/workspaces/:workspaceId/agents', requireActor(['user']), authed(agentsController.createAgent));
agentsRouter.get('/agents/:agentId', requireActor(['user']), authed(agentsController.getAgent));
agentsRouter.patch('/agents/:agentId', requireActor(['user']), authed(agentsController.updateAgent));
agentsRouter.delete('/agents/:agentId', requireActor(['user']), authed(agentsController.deleteAgent));
agentsRouter.get('/agents/:agentId/versions', requireActor(['user']), authed(agentsController.listAgentVersions));
agentsRouter.post('/agents/:agentId/versions', requireActor(['user']), authed(agentsController.createAgentVersion));
agentsRouter.post('/agents/:agentId/versions/:versionId/restore', requireActor(['user']), authed(agentsController.restoreAgentVersion));
agentsRouter.post('/agents/:agentId/test', requireActor(['user']), authed(agentsController.testAgent));
agentsRouter.get('/agents/:agentId/activity', requireActor(['user']), authed(agentsController.listAgentActivity));
agentsRouter.post('/agents/:agentId/triggers', requireActor(['user']), authed(agentsController.createAgentTrigger));
agentsRouter.patch('/agents/:agentId/triggers/:triggerId', requireActor(['user']), authed(agentsController.updateAgentTrigger));
agentsRouter.delete('/agents/:agentId/triggers/:triggerId', requireActor(['user']), authed(agentsController.deleteAgentTrigger));
