import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import {
  createMcpServerSchema,
  createTargetSkillSchema,
  importTargetSkillSchema,
  reimportTargetSkillSchema,
  updateMcpServerSchema,
  updateTargetMcpServerToolSchema,
  updateTargetSkillSchema,
  updateTargetToolSchema
} from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerTargetRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/targets', requireUser, authed(workspacesController.listTargets));
  router.get('/workspaces/:workspaceId/targets/:targetId/issues', requireUser, authed(workspacesController.listTargetIssues));
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/catalog',
    requireUser,
    authed(workspacesController.listTargetMcpCatalog)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/tools',
    requireUser,
    authed(workspacesController.listTargetTools)
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
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/skills',
    requireUser,
    authed(workspacesController.listTargetSkills)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills',
    requireUser,
    validateBody(createTargetSkillSchema),
    authed(workspacesController.createTargetSkillForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills/import',
    requireUser,
    validateBody(importTargetSkillSchema),
    authed(workspacesController.importTargetSkillForTarget)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireUser,
    authed(workspacesController.getTargetSkillForTarget)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireUser,
    validateBody(updateTargetSkillSchema),
    authed(workspacesController.updateTargetSkillForTarget)
  );
  router.delete(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireUser,
    authed(workspacesController.deleteTargetSkillForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId/reimport',
    requireUser,
    validateBody(reimportTargetSkillSchema),
    authed(workspacesController.reimportTargetSkillForTarget)
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
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/tools/:toolName',
    requireUser,
    validateBody(updateTargetMcpServerToolSchema),
    authed(workspacesController.updateTargetMcpServerToolSettings)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/tools/:toolId',
    requireUser,
    validateBody(updateTargetToolSchema),
    authed(workspacesController.updateTargetToolSettings)
  );
  router.get('/workspaces/:workspaceId/targets/:targetId', requireUser, authed(workspacesController.getTarget));
}
