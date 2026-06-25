import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../auth/middleware.js';
import * as workflowsController from '../controllers/workflows-controller.js';

export const workflowsRouter = Router();
const authed = authenticatedHandler;

workflowsRouter.get('/workspaces/:workspaceId/workflows', requireActor(['user']), authed(workflowsController.listWorkflows));
workflowsRouter.post('/workspaces/:workspaceId/workflows', requireActor(['user']), authed(workflowsController.createWorkflow));
workflowsRouter.get('/workspaces/:workspaceId/workflow-options', requireActor(['user']), authed(workflowsController.listWorkflowOptions));
workflowsRouter.get('/workspaces/:workspaceId/mcp/servers', requireActor(['user']), authed(workflowsController.listWorkflowMcpServersForWorkspace));
workflowsRouter.post('/workspaces/:workspaceId/mcp/servers', requireActor(['user']), authed(workflowsController.createWorkflowMcpServerForWorkspace));
workflowsRouter.patch('/workspaces/:workspaceId/mcp/servers/:serverId', requireActor(['user']), authed(workflowsController.updateWorkflowMcpServerForWorkspace));
workflowsRouter.delete('/workspaces/:workspaceId/mcp/servers/:serverId', requireActor(['user']), authed(workflowsController.deleteWorkflowMcpServerForWorkspace));
workflowsRouter.post('/workspaces/:workspaceId/mcp/servers/:serverId/test-connection', requireActor(['user']), authed(workflowsController.testWorkflowMcpServerConnectionForWorkspace));
workflowsRouter.get('/workspaces/:workspaceId/mcp/servers/:serverId/tools', requireActor(['user']), authed(workflowsController.listWorkflowMcpServerToolsForWorkspace));
workflowsRouter.get('/workflows/:workflowId', requireActor(['user']), authed(workflowsController.getWorkflow));
workflowsRouter.patch('/workflows/:workflowId', requireActor(['user']), authed(workflowsController.updateWorkflow));
workflowsRouter.delete('/workflows/:workflowId', requireActor(['user']), authed(workflowsController.deleteWorkflow));
workflowsRouter.get('/workflows/:workflowId/sessions', requireActor(['user']), authed(workflowsController.listSessions));
workflowsRouter.post('/workflows/:workflowId/sessions', requireActor(['user']), authed(workflowsController.createSession));
workflowsRouter.post('/workflow-sessions/:sessionId/messages', requireActor(['user']), authed(workflowsController.postMessage));
