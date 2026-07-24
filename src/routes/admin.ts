import { Router } from 'express';
import { requireAdminScope, adminHandler } from '../auth/admin-token.js';
import * as adminController from '../controllers/admin-controller.js';
import {
  adminAddWorkspaceMemberSchema,
  adminDeleteWorkspaceMemberSchema,
  adminMarkRunFailedSchema,
  adminReasonOnlySchema,
  adminToolingSyncSchema,
  adminUpdateWorkspaceMemberRoleSchema,
  adminWorkspacePlanPatchSchema,
  adminWorkspaceQuotaPatchSchema,
  adminWorkspaceRestoreSchema,
  adminWorkspaceSuspendSchema
} from '../types/contracts.js';
import { validateBody } from '../utils/http.js';
import { incrementAdminRequests } from '../metrics.js';

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.on('finish', () => {
    incrementAdminRequests(req.method, req.route?.path ? String(req.route.path) : req.path, res.statusCode);
  });
  next();
});

adminRouter.get('/me', requireAdminScope('admin:self'), adminHandler(adminController.me));

adminRouter.get('/system/readiness', requireAdminScope('admin:system:read'), adminHandler(adminController.systemReadiness));
adminRouter.get('/system/config', requireAdminScope('admin:system:read'), adminHandler(adminController.systemConfig));

adminRouter.get('/workspaces', requireAdminScope('admin:workspace:read'), adminHandler(adminController.listWorkspaces));
adminRouter.get('/workspaces/:workspaceId', requireAdminScope('admin:workspace:read'), adminHandler(adminController.getWorkspace));
adminRouter.get('/workspaces/:workspaceId/members', requireAdminScope('admin:user:read'), adminHandler(adminController.listWorkspaceMembers));
adminRouter.patch(
  '/workspaces/:workspaceId/plan',
  requireAdminScope('admin:workspace:write'),
  validateBody(adminWorkspacePlanPatchSchema),
  adminHandler(adminController.patchWorkspacePlan)
);
adminRouter.post(
  '/workspaces/:workspaceId/suspend',
  requireAdminScope('admin:workspace:write'),
  validateBody(adminWorkspaceSuspendSchema),
  adminHandler(adminController.suspendWorkspace)
);
adminRouter.post(
  '/workspaces/:workspaceId/restore',
  requireAdminScope('admin:workspace:write'),
  validateBody(adminWorkspaceRestoreSchema),
  adminHandler(adminController.restoreWorkspace)
);
adminRouter.patch(
  '/workspaces/:workspaceId/quotas',
  requireAdminScope('admin:workspace:write'),
  validateBody(adminWorkspaceQuotaPatchSchema),
  adminHandler(adminController.patchWorkspaceQuotas)
);

adminRouter.get('/users', requireAdminScope('admin:user:read'), adminHandler(adminController.listUsers));
adminRouter.get('/users/:userId', requireAdminScope('admin:user:read'), adminHandler(adminController.getUser));
adminRouter.post(
  '/users/:userId/sessions/revoke',
  requireAdminScope('admin:user:write'),
  validateBody(adminReasonOnlySchema),
  adminHandler(adminController.revokeUserSessions)
);

adminRouter.post(
  '/workspaces/:workspaceId/members',
  requireAdminScope('admin:member:write'),
  validateBody(adminAddWorkspaceMemberSchema),
  adminHandler(adminController.addWorkspaceMember)
);
adminRouter.patch(
  '/workspaces/:workspaceId/members/:userId/role',
  requireAdminScope('admin:member:write'),
  validateBody(adminUpdateWorkspaceMemberRoleSchema),
  adminHandler(adminController.updateWorkspaceMemberRole)
);
adminRouter.delete(
  '/workspaces/:workspaceId/members/:userId',
  requireAdminScope('admin:member:write'),
  validateBody(adminDeleteWorkspaceMemberSchema),
  adminHandler(adminController.deleteWorkspaceMember)
);

adminRouter.get('/targets', requireAdminScope('admin:target:read'), adminHandler(adminController.listTargets));
adminRouter.get('/targets/:targetId/agent', requireAdminScope('admin:target:read'), adminHandler(adminController.getTargetAgent));
adminRouter.post(
  '/targets/:targetId/agent/disconnect',
  requireAdminScope('admin:target:write'),
  validateBody(adminReasonOnlySchema),
  adminHandler(adminController.disconnectTargetAgent)
);
adminRouter.post(
  '/targets/:targetId/agent-key/rotate',
  requireAdminScope('admin:agent-key:rotate'),
  validateBody(adminReasonOnlySchema),
  adminHandler(adminController.rotateTargetAgentKey)
);

adminRouter.get('/runs', requireAdminScope('admin:run:read'), adminHandler(adminController.listRuns));
adminRouter.get('/runs/:runId', requireAdminScope('admin:run:read'), adminHandler(adminController.getRun));
adminRouter.post('/runs/:runId/cancel', requireAdminScope('admin:run:write'), validateBody(adminReasonOnlySchema), adminHandler(adminController.cancelRun));
adminRouter.post('/runs/:runId/mark-failed', requireAdminScope('admin:run:write'), validateBody(adminMarkRunFailedSchema), adminHandler(adminController.markRunFailed));

adminRouter.post('/tooling/sync', requireAdminScope('admin:tooling:write'), validateBody(adminToolingSyncSchema), adminHandler(adminController.syncTooling));

adminRouter.get('/admin-audit-events', requireAdminScope('admin:audit:read'), adminHandler(adminController.listAdminAuditEvents));
adminRouter.get('/audit-events', requireAdminScope('admin:audit:read'), adminHandler(adminController.listWorkspaceAuditEvents));
