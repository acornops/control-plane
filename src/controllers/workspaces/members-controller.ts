import { NextFunction, Request, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import {
  requireWorkspaceCapability
} from '../../auth/workspace-authorization.js';
import { isSupportedRole } from '../../auth/authorization.js';
import { repo } from '../../store/repository.js';
import { cleanupRemovedMemberMcpConnections } from '../../services/mcp-secret-cleanup-worker.js';
import { Role, WorkspaceInvitation, WorkspaceMembership } from '../../types/domain.js';
import { generateWorkspaceInviteToken, hashToken } from '../../utils/crypto.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';
import {
  canManageMembership,
  serializeWorkspaceInvitation,
  serializeWorkspaceMembership
} from './common.js';

function sendUnsupportedRole(res: Response, role: string): void {
  res.status(400).json({
    error: {
      code: 'ROLE_NOT_SUPPORTED',
      message: `Workspace role is not supported by this deployment: ${role}`,
      retryable: false
    }
  });
}

function roleFilterValue(role: string | undefined): Role | undefined {
  return role && isSupportedRole(role) ? role : undefined;
}

export async function listWorkspaceMembers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'read_members',
        'No access to workspace members',
        'No access to workspace members'
      ))
    ) {
      return;
    }

    const q = normalizeSearchQuery(req.query.q);
    const role = toSingleParam(req.query.role as string | string[] | undefined);
    const source = toSingleParam(req.query.source as string | string[] | undefined);
    const filters: { q: string; role?: Role; source?: WorkspaceMembership['source'] } = {
      q,
      role: roleFilterValue(role),
      source: source === 'oidc' || source === 'internal' ? source : undefined
    };
    if (role && !filters.role) {
      sendUnsupportedRole(res, role);
      return;
    }
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ roleRank: number; email: string; userId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listWorkspaceMembers(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      role: filters.role,
      source: filters.source,
      signature
    });
    res.status(200).json({
      items: page.items.map(serializeWorkspaceMembership),
      nextCursor: page.nextCursor
    });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function addWorkspaceMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }
    const actorRole = actorAuthz.role;
    if (!isSupportedRole(req.body.role)) {
      sendUnsupportedRole(res, req.body.role);
      return;
    }
    if (!canManageMembership(actorRole, undefined, req.body.role)) {
      res.status(403).json({
        error: { code: 'PROTECTED_ROLE_REQUIRES_OWNER', message: 'Only workspace owners can assign protected roles', retryable: false }
      });
      return;
    }

    const result = await repo.addWorkspaceMember(
      workspaceId,
      {
        email: req.body.email,
        displayName: req.body.displayName,
        role: req.body.role
      },
      req.auth.userId
    );
    if (result.status === 'workspace_not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false } });
      return;
    }
    if (result.status === 'already_exists') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'User is already a workspace member', retryable: false } });
      return;
    }

    res.status(201).json(serializeWorkspaceMembership(result.member));
  } catch (err) {
    next(err);
  }
}

export async function createWorkspaceInvitation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }
    const actorRole = actorAuthz.role;
    if (!isSupportedRole(req.body.role)) {
      sendUnsupportedRole(res, req.body.role);
      return;
    }
    if (!canManageMembership(actorRole, undefined, req.body.role)) {
      res.status(403).json({
        error: { code: 'PROTECTED_ROLE_REQUIRES_OWNER', message: 'Only workspace owners can invite protected roles', retryable: false }
      });
      return;
    }

    const token = generateWorkspaceInviteToken();
    const expiresInDays = Number.isFinite(req.body.expiresInDays) ? req.body.expiresInDays : 7;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const result = await repo.createWorkspaceInvitation(
      workspaceId,
      {
        email: req.body.email,
        role: req.body.role,
        tokenHash: hashToken(token),
        expiresAt
      },
      req.auth.userId
    );

    if (result.status === 'workspace_not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false } });
      return;
    }
    if (result.status === 'already_member') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'User is already a workspace member', retryable: false } });
      return;
    }
    res.status(201).json(serializeWorkspaceInvitation(result.invitation, token));
  } catch (err) {
    next(err);
  }
}

export async function listWorkspaceInvitations(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const role = toSingleParam(req.query.role as string | string[] | undefined);
    const status = toSingleParam(req.query.status as string | string[] | undefined);
    const filters: { q: string; role?: Role; status?: WorkspaceInvitation['status'] } = {
      q,
      role: roleFilterValue(role),
      status: status === 'pending' || status === 'accepted' || status === 'revoked' || status === 'expired' ? status : undefined
    };
    if (role && !filters.role) {
      sendUnsupportedRole(res, role);
      return;
    }
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ createdAt: string; invitationId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listWorkspaceInvitations(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      q,
      role: filters.role,
      status: filters.status,
      signature
    });
    res.status(200).json({
      items: page.items.map((invitation) => serializeWorkspaceInvitation(invitation)),
      nextCursor: page.nextCursor
    });
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function revokeWorkspaceInvitation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const invitationId = toSingleParam(req.params.invitationId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }

    const result = await repo.revokeWorkspaceInvitation(workspaceId, invitationId, req.auth.userId);
    if (result.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found', retryable: false } });
      return;
    }
    if (result.status === 'unavailable') {
      res.status(409).json({ error: { code: 'INVITATION_UNAVAILABLE', message: 'Invitation can no longer be revoked', retryable: false } });
      return;
    }
    res.status(200).json(serializeWorkspaceInvitation(result.invitation));
  } catch (err) {
    next(err);
  }
}

export async function getWorkspaceInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = toSingleParam(req.params.token);
    const invitation = await repo.getWorkspaceInvitationByTokenHash(hashToken(token));
    if (!invitation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found', retryable: false } });
      return;
    }
    res.status(200).json(serializeWorkspaceInvitation(invitation));
  } catch (err) {
    next(err);
  }
}

export async function acceptWorkspaceInvitation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = toSingleParam(req.params.token);
    const result = await repo.acceptWorkspaceInvitation(hashToken(token), req.auth.userId);
    if (result.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found', retryable: false } });
      return;
    }
    if (result.status === 'expired') {
      res.status(410).json({ error: { code: 'INVITATION_EXPIRED', message: 'Invitation has expired', retryable: false } });
      return;
    }
    if (result.status === 'unavailable') {
      res.status(409).json({ error: { code: 'INVITATION_UNAVAILABLE', message: 'Invitation is no longer available', retryable: false } });
      return;
    }
    if (result.status === 'workspace_suspended') {
      res.status(409).json({
        error: {
          code: 'WORKSPACE_SUSPENDED',
          message: 'This workspace is suspended and cannot accept invitations',
          retryable: false
        }
      });
      return;
    }
    if (result.status === 'email_mismatch') {
      res.status(403).json({
        error: {
          code: 'INVITATION_EMAIL_MISMATCH',
          message: `This invitation is for ${result.expectedEmail}. Sign in with that account to accept it.`,
          retryable: false
        }
      });
      return;
    }
    if (result.status === 'email_unverified') {
      res.status(403).json({
        error: {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: `Verify ${result.email} before accepting this workspace invite.`,
          retryable: false,
          details: { email: result.email }
        }
      });
      return;
    }

    res.status(200).json({
      workspaceId: result.workspaceId,
      member: serializeWorkspaceMembership(result.member)
    });
  } catch (err) {
    next(err);
  }
}

export async function updateWorkspaceMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }
    const actorRole = actorAuthz.role;
    if (!isSupportedRole(req.body.role)) {
      sendUnsupportedRole(res, req.body.role);
      return;
    }

    const target = await repo.getWorkspaceMember(workspaceId, userId);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace member not found', retryable: false } });
      return;
    }
    if (!canManageMembership(actorRole, target.role, req.body.role)) {
      res.status(403).json({
        error: { code: 'PROTECTED_ROLE_REQUIRES_OWNER', message: 'Only workspace owners can manage protected roles', retryable: false }
      });
      return;
    }

    const result = await repo.updateWorkspaceMemberRole(workspaceId, userId, req.body.role, req.auth.userId);
    if (result.status === 'last_owner') {
      res.status(409).json({ error: { code: 'LAST_OWNER', message: 'Workspace must keep at least one owner', retryable: false } });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace member not found', retryable: false } });
      return;
    }

    res.status(200).json(serializeWorkspaceMembership(result.member));
  } catch (err) {
    next(err);
  }
}

export async function deleteWorkspaceMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const userId = toSingleParam(req.params.userId);
    const actorAuthz = await requireWorkspaceCapability(
      req,
      res,
      workspaceId,
      'manage_members',
      'Only workspace roles with member-management capability can manage members',
      'Only workspace roles with member-management capability can manage members'
    );
    if (!actorAuthz) {
      return;
    }
    const actorRole = actorAuthz.role;

    const target = await repo.getWorkspaceMember(workspaceId, userId);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace member not found', retryable: false } });
      return;
    }
    if (!canManageMembership(actorRole, target.role)) {
      res.status(403).json({
        error: { code: 'PROTECTED_ROLE_REQUIRES_OWNER', message: 'Only workspace owners can manage protected roles', retryable: false }
      });
      return;
    }

    const result = await repo.deleteWorkspaceMember(workspaceId, userId, req.auth.userId);
    if (result.status === 'last_owner') {
      res.status(409).json({ error: { code: 'LAST_OWNER', message: 'Workspace must keep at least one owner', retryable: false } });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace member not found', retryable: false } });
      return;
    }

    await cleanupRemovedMemberMcpConnections(workspaceId, userId);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
