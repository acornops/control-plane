import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { createMcpServerSchema, updateMcpServerSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerTargetRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/targets', requireUser, authed(workspacesController.listTargets));
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/tools/catalog',
    requireUser,
    authed(workspacesController.listTargetToolsCatalog)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers',
    requireUser,
    authed(workspacesController.listTargetMcpServers)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/tools',
    requireUser,
    authed(workspacesController.listTargetMcpServerTools)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers',
    requireUser,
    validateBody(createMcpServerSchema),
    authed(workspacesController.createTargetMcpServerForTarget)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId',
    requireUser,
    validateBody(updateMcpServerSchema),
    authed(workspacesController.updateTargetMcpServerForTarget)
  );
  router.delete(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId',
    requireUser,
    authed(workspacesController.deleteTargetMcpServerForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/test-connection',
    requireUser,
    authed(workspacesController.testTargetMcpServerConnectionForTarget)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/tools/:toolName',
    requireUser,
    authed(workspacesController.updateTargetToolSettings)
  );
  router.get('/workspaces/:workspaceId/targets/:targetId', requireUser, authed(workspacesController.getTarget));
}
