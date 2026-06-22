import { Router } from 'express';
import { authenticatedHandler, requireActor } from '../../auth/middleware.js';
import * as workspacesController from '../../controllers/workspaces-controller.js';
import {
  addWorkspaceMemberSchema,
  createWorkspaceInvitationSchema,
  createWorkspaceSchema,
  updateWorkspaceAiSettingsSchema,
  updateWorkspaceMemberSchema,
  upsertWorkspaceAiProviderCredentialSchema
} from '../../types/contracts.js';
import { validateBody } from '../../utils/http.js';

const authed = authenticatedHandler;

export function registerWorkspaceRoutes(router: Router): void {
  router.get('/workspace-invitations/:token', workspacesController.getWorkspaceInvitation);
  router.post(
    '/workspace-invitations/:token/accept',
    requireActor(['user']),
    authed(workspacesController.acceptWorkspaceInvitation)
  );
  router.get('/workspaces', requireActor(['user', 'externalIntegration']), authed(workspacesController.listWorkspaces));
  router.post('/workspaces', requireActor(['user']), validateBody(createWorkspaceSchema), authed(workspacesController.createWorkspace));
  router.get('/workspaces/:workspaceId', requireActor(['user', 'externalIntegration']), authed(workspacesController.getWorkspace));
  router.delete('/workspaces/:workspaceId', requireActor(['user']), authed(workspacesController.deleteWorkspace));
  router.get('/workspaces/:workspaceId/roles', requireActor(['user']), authed(workspacesController.listWorkspaceRoleTemplates));
  router.get('/workspaces/:workspaceId/members', requireActor(['user']), authed(workspacesController.listWorkspaceMembers));
  router.get('/workspaces/:workspaceId/audit-log', requireActor(['user']), authed(workspacesController.listWorkspaceAuditEvents));
  router.get('/workspaces/:workspaceId/ai-settings', requireActor(['user']), authed(workspacesController.getWorkspaceAiSettings));
  router.patch(
    '/workspaces/:workspaceId/ai-settings',
    requireActor(['user']),
    validateBody(updateWorkspaceAiSettingsSchema),
    authed(workspacesController.updateWorkspaceAiSettings)
  );
  router.put(
    '/workspaces/:workspaceId/ai-provider-credentials/:provider',
    requireActor(['user']),
    validateBody(upsertWorkspaceAiProviderCredentialSchema),
    authed(workspacesController.upsertWorkspaceAiProviderCredential)
  );
  router.delete(
    '/workspaces/:workspaceId/ai-provider-credentials/:provider',
    requireActor(['user']),
    authed(workspacesController.deleteWorkspaceAiProviderCredential)
  );
  router.get('/workspaces/:workspaceId/invitations', requireActor(['user']), authed(workspacesController.listWorkspaceInvitations));
  router.post(
    '/workspaces/:workspaceId/invitations',
    requireActor(['user']),
    validateBody(createWorkspaceInvitationSchema),
    authed(workspacesController.createWorkspaceInvitation)
  );
  router.delete(
    '/workspaces/:workspaceId/invitations/:invitationId',
    requireActor(['user']),
    authed(workspacesController.revokeWorkspaceInvitation)
  );
  router.post(
    '/workspaces/:workspaceId/members',
    requireActor(['user']),
    validateBody(addWorkspaceMemberSchema),
    authed(workspacesController.addWorkspaceMember)
  );
  router.patch(
    '/workspaces/:workspaceId/members/:userId',
    requireActor(['user']),
    validateBody(updateWorkspaceMemberSchema),
    authed(workspacesController.updateWorkspaceMember)
  );
  router.delete('/workspaces/:workspaceId/members/:userId', requireActor(['user']), authed(workspacesController.deleteWorkspaceMember));
  router.get('/workspaces/:workspaceId/investigations', requireActor(['user', 'externalIntegration']), authed(workspacesController.listWorkspaceInvestigations));
}
