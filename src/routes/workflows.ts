import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import * as workflowsController from '../controllers/workflows-controller.js';

export const workflowsRouter = Router();
const authed = authenticatedHandler;

workflowsRouter.get('/workspaces/:workspaceId/workflows', requireUser, authed(workflowsController.listWorkflows));
workflowsRouter.post('/workspaces/:workspaceId/workflows', requireUser, authed(workflowsController.createWorkflow));
workflowsRouter.get('/workspaces/:workspaceId/workflow-options', requireUser, authed(workflowsController.listWorkflowOptions));
workflowsRouter.get('/workspaces/:workspaceId/mcp/servers', requireUser, authed(workflowsController.listWorkflowMcpServersForWorkspace));
workflowsRouter.post('/workspaces/:workspaceId/mcp/servers', requireUser, authed(workflowsController.createWorkflowMcpServerForWorkspace));
workflowsRouter.patch('/workspaces/:workspaceId/mcp/servers/:serverId', requireUser, authed(workflowsController.updateWorkflowMcpServerForWorkspace));
workflowsRouter.delete('/workspaces/:workspaceId/mcp/servers/:serverId', requireUser, authed(workflowsController.deleteWorkflowMcpServerForWorkspace));
workflowsRouter.post('/workspaces/:workspaceId/mcp/servers/:serverId/test-connection', requireUser, authed(workflowsController.testWorkflowMcpServerConnectionForWorkspace));
workflowsRouter.get('/workspaces/:workspaceId/mcp/servers/:serverId/tools', requireUser, authed(workflowsController.listWorkflowMcpServerToolsForWorkspace));
workflowsRouter.get('/workflows/:workflowId', requireUser, authed(workflowsController.getWorkflow));
workflowsRouter.patch('/workflows/:workflowId', requireUser, authed(workflowsController.updateWorkflow));
workflowsRouter.delete('/workflows/:workflowId', requireUser, authed(workflowsController.deleteWorkflow));
workflowsRouter.get('/workflows/:workflowId/sessions', requireUser, authed(workflowsController.listSessions));
workflowsRouter.post('/workflows/:workflowId/sessions', requireUser, authed(workflowsController.createSession));
workflowsRouter.post('/workflow-sessions/:sessionId/messages', requireUser, authed(workflowsController.postMessage));
