import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { isSupportedRole } from '../auth/authorization.js';
import type { Role } from '../types/domain.js';
import { createServiceIdentity, listServiceIdentities, updateServiceIdentity } from '../store/repository-service-identities.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { toSingleParam } from '../utils/params.js';

export async function list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    res.status(200).json({ items: await listServiceIdentities(workspaceId) });
  } catch (error) { next(error); }
}

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage service identities'))) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role as Role : undefined;
    if (!name || !role || !isSupportedRole(role) || role === 'owner') {
      res.status(400).json({ error: { code: 'SERVICE_IDENTITY_INVALID', message: 'name and a non-owner workspace role are required.', retryable: false } }); return;
    }
    const identity = await createServiceIdentity({ workspaceId, name, role, createdBy: req.auth.userId });
    await recordWorkspaceAuditEvent({ workspaceId, category: 'workspace', eventType: 'service_identity.created.v1', operation: 'write', actorUserId: req.auth.userId, objectType: 'service_identity', objectId: identity.id, objectName: identity.name, summary: 'Service identity created', metadata: { role: identity.role } });
    res.status(201).json({ identity });
  } catch (error) { next(error); }
}

export async function patch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage service identities'))) return;
    const id = toSingleParam(req.params.serviceIdentityId);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const role = typeof body.role === 'string' ? body.role as Role : undefined;
    const status = body.status === 'active' || body.status === 'disabled' ? body.status : undefined;
    if (role && (!isSupportedRole(role) || role === 'owner')) {
      res.status(400).json({ error: { code: 'SERVICE_IDENTITY_INVALID', message: 'Service identities cannot use the owner role.', retryable: false } }); return;
    }
    const identity = await updateServiceIdentity({ workspaceId, id, name: typeof body.name === 'string' ? body.name : undefined, role, status });
    if (!identity) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Service identity not found', retryable: false } }); return; }
    await recordWorkspaceAuditEvent({ workspaceId, category: 'workspace', eventType: 'service_identity.updated.v1', operation: 'write', actorUserId: req.auth.userId, objectType: 'service_identity', objectId: identity.id, objectName: identity.name, summary: 'Service identity updated', metadata: { role: identity.role, status: identity.status } });
    res.status(200).json({ identity });
  } catch (error) { next(error); }
}
