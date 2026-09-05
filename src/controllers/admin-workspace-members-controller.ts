import type { NextFunction, Response } from 'express';

import type { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { isSupportedRole } from '../auth/authorization.js';
import { incrementAdminMutations } from '../metrics.js';
import { repo } from '../store/repository.js';
import { QuotaExceededError, effectiveWorkspaceLimits } from '../store/repository-quotas.js';
import { toSingleParam } from '../utils/params.js';
import {
  handleAdminMemberMcpLifecycleError,
  reconcileAdminMemberMcpLifecycle,
  retryActiveAdminMemberMcpLifecycle,
  retryRemovedAdminMemberMcpLifecycle
} from './admin-membership-mcp-lifecycle.js';
import { auditAdminMutationRequest, notFound, validationError } from './admin-controller-common.js';
import { membershipAudit } from './admin-membership-audit.js';

export async function addWorkspaceMember(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const workspace = await repo.getAdminWorkspace(workspaceId);
    if (!workspace) {
      notFound(res, 'Workspace not found');
      return;
    }
    if (!isSupportedRole(req.body.role)) {
      validationError(res, 'Workspace role is not supported by this deployment');
      return;
    }
    let userId = req.body.userId as string | undefined;
    let addRequestAudited = false;
    if (!userId && req.body.email) {
      let user = await repo.findUserByEmail(req.body.email);
      if (!user && req.body.createUserIfMissing) {
        const usage = await repo.countWorkspaceUsage(workspaceId);
        const limit = effectiveWorkspaceLimits(workspace.plan.key, workspace.quotaOverrides).quotas.members;
        if (usage.members >= limit) {
          throw new QuotaExceededError(
            'workspaceMembers', usage.members, limit,
            `Workspace has reached the member limit of ${limit}`
          );
        }
        await auditAdminMutationRequest(req, {
          action: 'admin.workspace.member.add',
          workspaceId,
          reason: req.body.reason,
          metadata: {
            email: req.body.email,
            role: req.body.role,
            createUserIfMissing: true,
            ticketRef: req.body.ticketRef || null
          }
        });
        addRequestAudited = true;
        user = await repo.createVerifiedInternalUser(req.body.email, req.body.email.split('@')[0]);
      }
      if (!user) {
        notFound(res, 'User not found');
        return;
      }
      userId = user.id;
    }
    if (userId && !addRequestAudited) {
      await auditAdminMutationRequest(req, {
        action: 'admin.workspace.member.add',
        workspaceId,
        subjectType: 'user',
        subjectId: userId,
        reason: req.body.reason,
        metadata: { role: req.body.role, ticketRef: req.body.ticketRef || null }
      });
    }
    const result = await repo.addExistingWorkspaceMember(
      workspaceId,
      userId!,
      req.body.role,
      membershipAudit(req, {
        action: 'admin.workspace.member.add',
        workspaceId,
        userId: userId!,
        reason: req.body.reason,
        eventType: 'workspace.member.added.v1',
        summary: 'Workspace access granted by a platform administrator',
        metadata: { role: req.body.role, ticketRef: req.body.ticketRef || null }
      })
    );
    if (result.status === 'user_not_found') {
      notFound(res, 'User not found');
      return;
    }
    if (result.status === 'already_exists') {
      const member = await retryActiveAdminMemberMcpLifecycle(workspaceId, userId!);
      if (member) {
        res.status(200).json(member);
        return;
      }
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'User is already a workspace member', retryable: false }
      });
      return;
    }
    await reconcileAdminMemberMcpLifecycle({
      workspaceId,
      userId: result.member!.userId,
      membershipGeneration: result.membershipGeneration!,
      status: 'active'
    });
    res.status(201).json(result.member);
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      res.status(409).json({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: error.message,
          retryable: false,
          details: { quotaKey: error.quotaKey, used: error.used, limit: error.limit }
        }
      });
      return;
    }
    if (handleAdminMemberMcpLifecycleError(
      res,
      error,
      'Workspace membership was saved, but MCP access activation did not complete; retry the request.'
    )) return;
    next(error);
  }
}

export async function updateWorkspaceMemberRole(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    if (!isSupportedRole(req.body.role)) {
      validationError(res, 'Workspace role is not supported by this deployment');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.member.role.update',
      workspaceId,
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: { requestedRole: req.body.role, ticketRef: req.body.ticketRef || null }
    });
    const result = await repo.updateExistingWorkspaceMemberRole(
      workspaceId,
      userId,
      req.body.role,
      membershipAudit(req, {
        action: 'admin.workspace.member.role.update',
        workspaceId,
        userId,
        reason: req.body.reason,
        eventType: 'workspace.member.role_updated.v1',
        summary: 'Workspace access role changed by a platform administrator',
        metadata: { afterRole: req.body.role, ticketRef: req.body.ticketRef || null }
      })
    );
    if (result.status === 'not_found') {
      notFound(res, 'Workspace member not found');
      return;
    }
    if (result.status === 'last_owner') {
      res.status(409).json({
        error: { code: 'LAST_OWNER', message: 'Workspace must keep at least one owner', retryable: false }
      });
      return;
    }
    res.status(200).json(result.member);
  } catch (error) {
    next(error);
  }
}

export async function deleteWorkspaceMember(
  req: AdminAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    incrementAdminMutations();
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    const current = await repo.getWorkspaceMember(workspaceId, userId);
    if (!current) {
      const retry = await retryRemovedAdminMemberMcpLifecycle(workspaceId, userId);
      if (retry) {
        res.status(204).send();
        return;
      }
      notFound(res, 'Workspace member not found');
      return;
    }
    if (req.body.replacementOwnerUserId === userId) {
      validationError(res, 'replacementOwnerUserId must be different from the removed member');
      return;
    }
    await auditAdminMutationRequest(req, {
      action: 'admin.workspace.member.delete',
      workspaceId,
      subjectType: 'user',
      subjectId: userId,
      reason: req.body.reason,
      metadata: {
        previousRole: current.role,
        replacementOwnerUserId: req.body.replacementOwnerUserId || null,
        ticketRef: req.body.ticketRef || null
      }
    });
    const removalAudit = membershipAudit(req, {
      action: 'admin.workspace.member.delete',
      workspaceId,
      userId,
      reason: req.body.reason,
      eventType: 'workspace.member.removed.v1',
      summary: 'Workspace access revoked by a platform administrator',
      metadata: { previousRole: current.role, ticketRef: req.body.ticketRef || null }
    });
    let result = await repo.deleteExistingWorkspaceMember(workspaceId, userId, removalAudit);
    if (result.status === 'last_owner' && req.body.replacementOwnerUserId) {
      const replacementAudit = membershipAudit(req, {
        action: 'admin.workspace.member.delete',
        workspaceId,
        userId,
        reason: req.body.reason,
        eventType: 'workspace.member.removed.v1',
        summary: 'Workspace access revoked by a platform administrator',
        metadata: {
          previousRole: current.role,
          replacementOwnerUserId: req.body.replacementOwnerUserId,
          ticketRef: req.body.ticketRef || null
        },
        extraWorkspaceEvents: [{
          workspaceId,
          category: 'membership',
          eventType: 'workspace.member.role_updated.v1',
          operation: 'write',
          objectType: 'member',
          objectId: req.body.replacementOwnerUserId,
          summary: 'Workspace owner assigned by a platform administrator',
          metadata: { afterRole: 'owner' }
        }]
      });
      const replacement = await repo.replaceLastOwnerAndDeleteMember(
        workspaceId,
        userId,
        req.body.replacementOwnerUserId,
        replacementAudit
      );
      if (replacement.status === 'replacement_not_found') {
        validationError(res, 'replacementOwnerUserId must be an existing workspace member');
        return;
      }
      result = replacement.status === 'deleted'
        ? {
            status: 'deleted',
            member: replacement.member!,
            membershipGeneration: replacement.membershipGeneration
          }
        : { status: 'not_found' };
    }
    if (result.status === 'last_owner') {
      res.status(409).json({
        error: {
          code: 'LAST_OWNER',
          message: 'replacementOwnerUserId is required to remove the last owner',
          retryable: false
        }
      });
      return;
    }
    if (result.status === 'not_found') {
      const retry = await retryRemovedAdminMemberMcpLifecycle(workspaceId, userId);
      if (retry) {
        res.status(204).send();
        return;
      }
      notFound(res, 'Workspace member not found');
      return;
    }
    await reconcileAdminMemberMcpLifecycle({
      workspaceId,
      userId,
      membershipGeneration: result.membershipGeneration!,
      status: 'removed'
    });
    res.status(204).send();
  } catch (error) {
    if (handleAdminMemberMcpLifecycleError(
      res,
      error,
      'Workspace access was removed, but MCP user cleanup did not complete; retry the request.'
    )) return;
    next(error);
  }
}
