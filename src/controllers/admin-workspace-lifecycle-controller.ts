import { randomUUID } from 'node:crypto';
import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { incrementAdminMutations } from '../metrics.js';
import { repo } from '../store/repository.js';
import { toSingleParam } from '../utils/params.js';
import {
  auditAdmin,
  auditAdminMutationRequest,
  bestEffortWorkspaceAudit,
  conflictError,
  notFound,
  validationError
} from './admin-controller-common.js';

export async function suspendWorkspace(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const before = await repo.getAdminWorkspace(workspaceId);
    if (!before) {
      notFound(res, 'Workspace not found');
      return;
    }
    if (req.body.workspaceName !== before.name) {
      await auditAdmin(req, {
        action: 'admin.workspace.suspend',
        outcome: 'failure',
        workspaceId,
        reason: req.body.reason,
        metadata: { confirmationMatched: false, ticketRef: req.body.ticketRef || null }
      });
      validationError(res, 'Workspace name does not match');
      return;
    }
    if (before.lifecycleStatus === 'suspended') {
      await auditAdmin(req, {
        action: 'admin.workspace.suspend', outcome: 'failure', workspaceId, reason: req.body.reason,
        metadata: { beforeStatus: before.lifecycleStatus, requestedStatus: 'suspended', ticketRef: req.body.ticketRef || null }
      });
      conflictError(res, 'WORKSPACE_ALREADY_SUSPENDED', 'Workspace is already suspended');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.suspend',
      workspaceId,
      reason: req.body.reason,
      metadata: { workspaceNameConfirmed: true, ticketRef: req.body.ticketRef || null }
    });
    const result = await repo.transitionWorkspaceLifecycle(workspaceId, 'active', 'suspended');
    if (result.status === 'not_found') {
      notFound(res, 'Workspace not found');
      return;
    }
    if (result.status === 'state_conflict') {
      await auditAdmin(req, {
        action: 'admin.workspace.suspend', outcome: 'failure', workspaceId, reason: req.body.reason,
        metadata: { beforeStatus: before.lifecycleStatus, requestedStatus: 'suspended', stateConflict: true, ticketRef: req.body.ticketRef || null }
      });
      conflictError(res, 'WORKSPACE_STATE_CONFLICT', 'Workspace lifecycle changed before suspension completed');
      return;
    }
    const correlationId = randomUUID();
    await auditAdmin(req, {
      action: 'admin.workspace.suspend',
      workspaceId,
      reason: req.body.reason,
      metadata: { beforeStatus: before.lifecycleStatus, afterStatus: 'suspended', correlationId }
    });
    await bestEffortWorkspaceAudit({
      workspaceId,
      tokenId: req.admin.tokenId,
      category: 'workspace',
      eventType: 'workspace.suspended.v1',
      objectType: 'workspace',
      objectId: workspaceId,
      objectName: before.name,
      summary: 'Workspace access suspended by admin token',
      metadata: { reason: req.body.reason, correlationId }
    });
    res.status(200).json({ before, after: result.workspace });
  } catch (err) {
    next(err);
  }
}

export async function restoreWorkspace(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const before = await repo.getAdminWorkspace(workspaceId);
    if (!before) {
      notFound(res, 'Workspace not found');
      return;
    }
    if (req.body.workspaceName !== undefined && req.body.workspaceName !== before.name) {
      await auditAdmin(req, {
        action: 'admin.workspace.restore', outcome: 'failure', workspaceId, reason: req.body.reason,
        metadata: { confirmationMatched: false, ticketRef: req.body.ticketRef || null }
      });
      validationError(res, 'Workspace name does not match');
      return;
    }
    if (before.lifecycleStatus === 'active') {
      await auditAdmin(req, {
        action: 'admin.workspace.restore', outcome: 'failure', workspaceId, reason: req.body.reason,
        metadata: { beforeStatus: before.lifecycleStatus, requestedStatus: 'active', ticketRef: req.body.ticketRef || null }
      });
      conflictError(res, 'WORKSPACE_ALREADY_ACTIVE', 'Workspace is already active');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.restore',
      workspaceId,
      reason: req.body.reason,
      metadata: { workspaceNameConfirmed: req.body.workspaceName === before.name, ticketRef: req.body.ticketRef || null }
    });
    const result = await repo.transitionWorkspaceLifecycle(workspaceId, 'suspended', 'active');
    if (result.status === 'not_found') {
      notFound(res, 'Workspace not found');
      return;
    }
    if (result.status === 'state_conflict') {
      await auditAdmin(req, {
        action: 'admin.workspace.restore', outcome: 'failure', workspaceId, reason: req.body.reason,
        metadata: { beforeStatus: before.lifecycleStatus, requestedStatus: 'active', stateConflict: true, ticketRef: req.body.ticketRef || null }
      });
      conflictError(res, 'WORKSPACE_STATE_CONFLICT', 'Workspace lifecycle changed before restoration completed');
      return;
    }
    const correlationId = randomUUID();
    await auditAdmin(req, {
      action: 'admin.workspace.restore',
      workspaceId,
      reason: req.body.reason,
      metadata: { beforeStatus: before.lifecycleStatus, afterStatus: 'active', correlationId }
    });
    await bestEffortWorkspaceAudit({
      workspaceId,
      tokenId: req.admin.tokenId,
      category: 'workspace',
      eventType: 'workspace.restored.v1',
      objectType: 'workspace',
      objectId: workspaceId,
      objectName: before.name,
      summary: 'Workspace access restored by admin token',
      metadata: { reason: req.body.reason, correlationId }
    });
    res.status(200).json({ before, after: result.workspace });
  } catch (err) {
    next(err);
  }
}
