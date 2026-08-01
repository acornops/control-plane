import { Router } from 'express';
import { authenticatedHandler, requireUser } from '../auth/middleware.js';
import { listWorkspaceApprovalInbox } from '../controllers/workspace-approval-inbox-controller.js';

export const approvalsRouter = Router();

approvalsRouter.get(
  '/workspaces/:workspaceId/approvals',
  requireUser,
  authenticatedHandler(listWorkspaceApprovalInbox)
);
