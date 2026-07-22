import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import { importTargetCatalogMcpServer, reimportTargetCatalogMcpServer } from '../../controllers/catalog-controller.js';
import * as mcpConnectionsController from '../../controllers/mcp-connections-controller.js';
import {
  createMcpServerSchema,
  createTargetInsightsEntrySchema,
  createTargetSkillSchema,
  importTargetSkillSchema,
  reimportTargetSkillSchema,
  updateTargetInsightsEntrySchema,
  updateMcpServerSchema,
  updateTargetMcpServerToolSchema,
  updateTargetSkillSchema,
  updateTargetToolSchema
} from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerTargetRoutes(router: Router): void {
  router.get('/workspaces/:workspaceId/targets', requireActor(['user', 'externalIntegration']), authed(workspacesController.listTargets));
  router.get('/workspaces/:workspaceId/targets/:targetId/issues/summary', requireActor(['user', 'externalIntegration']), authed(workspacesController.getTargetIssueSummary));
  router.get('/workspaces/:workspaceId/targets/:targetId/issues', requireActor(['user', 'externalIntegration']), authed(workspacesController.listTargetIssues));
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/mcp/catalog',
    requireActor(['user']),
    authed(workspacesController.listTargetMcpCatalog)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/tools',
    requireActor(['user']),
    authed(workspacesController.listTargetTools)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/assistant/capabilities-preview',
    requireActor(['user']),
    authed(workspacesController.getTargetAssistantCapabilitiesPreview)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/target-insights',
    requireActor(['user']),
    authed(workspacesController.listTargetInsightsEntries)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/entries',
    requireActor(['user']),
    validateBody(createTargetInsightsEntrySchema),
    authed(workspacesController.createTargetInsightsEntry)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/activity',
    requireActor(['user']),
    authed(workspacesController.listTargetInsightsActivity)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/export',
    requireActor(['user']),
    authed(workspacesController.exportTargetInsights)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/reset',
    requireActor(['user']),
    authed(workspacesController.resetTargetInsights)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/entries/:entryId',
    requireActor(['user']),
    validateBody(updateTargetInsightsEntrySchema),
    authed(workspacesController.updateTargetInsightsEntry)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/entries/:entryId/promote',
    requireActor(['user']),
    authed(workspacesController.promoteTargetInsightsEntry)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/target-insights/entries/:entryId/archive',
    requireActor(['user']),
    authed(workspacesController.archiveTargetInsightsEntry)
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
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/skills',
    requireActor(['user']),
    authed(workspacesController.listTargetSkills)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills',
    requireActor(['user']),
    validateBody(createTargetSkillSchema),
    authed(workspacesController.createTargetSkillForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills/import',
    requireActor(['user']),
    validateBody(importTargetSkillSchema),
    authed(workspacesController.importTargetSkillForTarget)
  );
  router.get(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireActor(['user']),
    authed(workspacesController.getTargetSkillForTarget)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireActor(['user']),
    validateBody(updateTargetSkillSchema),
    authed(workspacesController.updateTargetSkillForTarget)
  );
  router.delete(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId',
    requireActor(['user']),
    authed(workspacesController.deleteTargetSkillForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/skills/:skillId/reimport',
    requireActor(['user']),
    validateBody(reimportTargetSkillSchema),
    authed(workspacesController.reimportTargetSkillForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers',
    requireActor(['user']),
    validateBody(createMcpServerSchema),
    authed(workspacesController.createTargetMcpServerForTarget)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/import',
    requireUser,
    authed(importTargetCatalogMcpServer)
  );
  router.post(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/reimport',
    requireUser,
    authed(reimportTargetCatalogMcpServer)
  );
  router.get('/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/connection', requireUser, authed(mcpConnectionsController.getMcpConnectionStatus));
  router.put('/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/connection', requireUser, authed(mcpConnectionsController.putMcpConnection));
  router.delete('/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/connection', requireUser, authed(mcpConnectionsController.deleteMcpConnectionStatus));
  router.post('/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/connection/verify', requireUser, authed(mcpConnectionsController.verifyMcpConnectionStatus));
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
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/mcp/servers/:serverId/tools/:toolName',
    requireActor(['user']),
    validateBody(updateTargetMcpServerToolSchema),
    authed(workspacesController.updateTargetMcpServerToolSettings)
  );
  router.patch(
    '/workspaces/:workspaceId/targets/:targetId/tools/:toolId',
    requireActor(['user']),
    validateBody(updateTargetToolSchema),
    authed(workspacesController.updateTargetToolSettings)
  );
  router.get('/workspaces/:workspaceId/targets/:targetId', requireActor(['user', 'externalIntegration']), authed(workspacesController.getTarget));
}
