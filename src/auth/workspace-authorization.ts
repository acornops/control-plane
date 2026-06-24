import { Response } from 'express';
import {
  getWorkspacePermissions,
  hasWorkspaceCapability,
  isSupportedRole,
  WorkspaceCapability,
  WorkspacePermissions
} from './authorization.js';
import { AuthenticatedRequest } from './middleware.js';
import { repo } from '../store/repository.js';
import { KubernetesCluster, Role, TargetSummary } from '../types/domain.js';

export interface WorkspaceAuthorization {
  userId: string;
  workspaceId: string;
  role: Role;
  permissions: WorkspacePermissions;
  can(capability: WorkspaceCapability): boolean;
}

export function getEffectiveWorkspacePermissions(
  _req: AuthenticatedRequest,
  role: Role | null | undefined
): WorkspacePermissions {
  return getWorkspacePermissions(role);
}

export async function getWorkspaceAuthorization(
  req: AuthenticatedRequest,
  workspaceId: string
): Promise<WorkspaceAuthorization | null> {
  const role = await repo.getWorkspaceRole(req.auth.userId, workspaceId);
  if (!role || !isSupportedRole(role)) {
    return null;
  }
  const permissions = getEffectiveWorkspacePermissions(req, role);
  return {
    userId: req.auth.userId,
    workspaceId,
    role,
    permissions,
    can(capability: WorkspaceCapability): boolean {
      return hasWorkspaceCapability(role, capability) && permissions[capability];
    }
  };
}

export async function requireWorkspaceRead(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  message = 'No access to workspace'
): Promise<WorkspaceAuthorization | null> {
  const authz = await getWorkspaceAuthorization(req, workspaceId);
  if (authz) {
    return authz;
  }
  res.status(403).json({ error: { code: 'FORBIDDEN', message, retryable: false } });
  return null;
}

export async function requireWorkspaceCapability(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  capability: WorkspaceCapability,
  message: string,
  readDeniedMessage = 'No access to workspace'
): Promise<WorkspaceAuthorization | null> {
  const authz = await requireWorkspaceRead(req, res, workspaceId, readDeniedMessage);
  if (!authz) {
    return null;
  }
  if (authz.can(capability)) {
    return authz;
  }
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message,
      retryable: false
    }
  });
  return null;
}

export async function requireWorkspaceDataRead(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  message = 'No access to workspace data'
): Promise<WorkspaceAuthorization | null> {
  return requireWorkspaceCapability(req, res, workspaceId, 'read_workspace_data', message, message);
}

export async function requireClusterAccess(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  clusterId: string
): Promise<{ authz: WorkspaceAuthorization; cluster: KubernetesCluster } | null> {
  const authz = await requireWorkspaceDataRead(req, res, workspaceId);
  if (!authz) {
    return null;
  }
  const cluster = await repo.getCluster(clusterId);
  if (!cluster || cluster.workspaceId !== workspaceId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Cluster not found', retryable: false } });
    return null;
  }
  return { authz, cluster };
}

export async function requireTargetAccess(
  req: AuthenticatedRequest,
  res: Response,
  workspaceId: string,
  targetId: string
): Promise<{ authz: WorkspaceAuthorization; target: TargetSummary } | null> {
  const authz = await requireWorkspaceDataRead(req, res, workspaceId);
  if (!authz) {
    return null;
  }
  const target = await repo.getTarget(workspaceId, targetId);
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found', retryable: false } });
    return null;
  }
  return { authz, target };
}
