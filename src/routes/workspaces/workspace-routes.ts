import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../../auth/middleware.js';
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
    requireUser,
    authed(workspacesController.acceptWorkspaceInvitation)
  );
  router.get('/workspaces', requireUser, authed(workspacesController.listWorkspaces));
  router.post('/workspaces', requireUser, validateBody(createWorkspaceSchema), authed(workspacesController.createWorkspace));
  router.get('/workspaces/:workspaceId', requireUser, authed(workspacesController.getWorkspace));
  router.delete('/workspaces/:workspaceId', requireUser, authed(workspacesController.deleteWorkspace));
  router.get('/workspaces/:workspaceId/roles', requireUser, authed(workspacesController.listWorkspaceRoleTemplates));
  router.get('/workspaces/:workspaceId/members', requireUser, authed(workspacesController.listWorkspaceMembers));
  router.get('/workspaces/:workspaceId/audit-log', requireUser, authed(workspacesController.listWorkspaceAuditEvents));
  router.get('/workspaces/:workspaceId/ai-settings', requireUser, authed(workspacesController.getWorkspaceAiSettings));
  router.patch(
    '/workspaces/:workspaceId/ai-settings',
    requireUser,
    validateBody(updateWorkspaceAiSettingsSchema),
    authed(workspacesController.updateWorkspaceAiSettings)
  );
  router.put(
    '/workspaces/:workspaceId/ai-provider-credentials/:provider',
    requireUser,
    validateBody(upsertWorkspaceAiProviderCredentialSchema),
    authed(workspacesController.upsertWorkspaceAiProviderCredential)
  );
  router.delete(
    '/workspaces/:workspaceId/ai-provider-credentials/:provider',
    requireUser,
    authed(workspacesController.deleteWorkspaceAiProviderCredential)
  );
  router.get(
    '/workspaces/:workspaceId/invitations',
    requireUser,
    authed(workspacesController.listWorkspaceInvitations)
  );
  router.post(
    '/workspaces/:workspaceId/invitations',
    requireUser,
    validateBody(createWorkspaceInvitationSchema),
    authed(workspacesController.createWorkspaceInvitation)
  );
  router.delete(
    '/workspaces/:workspaceId/invitations/:invitationId',
    requireUser,
    authed(workspacesController.revokeWorkspaceInvitation)
  );
  router.post(
    '/workspaces/:workspaceId/members',
    requireUser,
    validateBody(addWorkspaceMemberSchema),
    authed(workspacesController.addWorkspaceMember)
  );
  router.patch(
    '/workspaces/:workspaceId/members/:userId',
    requireUser,
    validateBody(updateWorkspaceMemberSchema),
    authed(workspacesController.updateWorkspaceMember)
  );
  router.delete(
    '/workspaces/:workspaceId/members/:userId',
    requireUser,
    authed(workspacesController.deleteWorkspaceMember)
  );
  router.get('/workspaces/:workspaceId/investigations', requireUser, authed(workspacesController.listWorkspaceInvestigations));
}
