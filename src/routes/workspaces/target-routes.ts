import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { createMcpServerSchema, updateMcpServerSchema } from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerTargetRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/targets', requireActor(['user']), authed(workspacesController.listTargets));
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/tools/catalog',
    requireActor(['user']),
    authed(workspacesController.listTargetToolsCatalog)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers',
    requireActor(['user']),
    authed(workspacesController.listTargetMcpServers)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/tools',
    requireActor(['user']),
    authed(workspacesController.listTargetMcpServerTools)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers',
    requireActor(['user']),
    validateBody(createMcpServerSchema),
    authed(workspacesController.createTargetMcpServerForTarget)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId',
    requireActor(['user']),
    validateBody(updateMcpServerSchema),
    authed(workspacesController.updateTargetMcpServerForTarget)
  );
  router.delete(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId',
    requireActor(['user']),
    authed(workspacesController.deleteTargetMcpServerForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/test-connection',
    requireActor(['user']),
    authed(workspacesController.testTargetMcpServerConnectionForTarget)
  );
  router.patch('/workspaces/:workspaceId/targets/:targetId/tools/:toolName', requireActor(['user']), authed(workspacesController.updateTargetToolSettings));
  router.get('/workspaces/:workspaceId/targets/:targetId', requireActor(['user']), authed(workspacesController.getTarget));
}
