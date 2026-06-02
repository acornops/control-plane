import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { repo } from '../store/repository.js';
import { WORKSPACE_AUDIT_CATEGORIES } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { CursorMismatchError, decodeCursor, makeQuerySignature, parseBoundedLimit } from '../utils/pagination.js';
import { auditAdmin, parseIsoDateQuery, parseStringFilter, validationError } from './admin-controller-common.js';

function parseRange(req: AdminAuthenticatedRequest, res: Response): { from?: string; to?: string } | null {
  const from = parseIsoDateQuery(req.query.from, 'from');
  const to = parseIsoDateQuery(req.query.to, 'to');
  if (from.error || to.error) {
    validationError(res, from.error || to.error!);
    return null;
  }
  if (from.value && to.value && new Date(from.value).getTime() > new Date(to.value).getTime()) {
    validationError(res, 'from must be earlier than or equal to to');
    return null;
  }
  return { from: from.value, to: to.value };
}

export async function listAdminAuditEvents(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const range = parseRange(req, res);
    if (!range) return;
    const outcome = parseStringFilter(req.query.outcome, 'outcome');
    if (outcome.error || (outcome.value && outcome.value !== 'success' && outcome.value !== 'failure')) {
      validationError(res, outcome.error || 'outcome must be success or failure');
      return;
    }
    const filters = {
      adminTokenId: parseStringFilter(req.query.adminTokenId, 'adminTokenId'),
      action: parseStringFilter(req.query.action, 'action'),
      workspaceId: parseStringFilter(req.query.workspaceId, 'workspaceId'),
      targetType: parseStringFilter(req.query.targetType, 'targetType'),
      targetId: parseStringFilter(req.query.targetId, 'targetId')
    };
    for (const parsed of Object.values(filters)) {
      if (parsed.error) {
        validationError(res, parsed.error);
        return;
      }
    }
    const normalizedFilters = {
      adminTokenId: filters.adminTokenId.value,
      action: filters.action.value,
      outcome: outcome.value as 'success' | 'failure' | undefined,
      workspaceId: filters.workspaceId.value,
      targetType: filters.targetType.value,
      targetId: filters.targetId.value,
      ...range
    };
    const signature = makeQuerySignature(normalizedFilters);
    const cursor = decodeCursor<{ occurredAt: string; eventId: string; signature: string }>(req.query.cursor, signature);
    await auditAdmin(req, { action: 'admin.admin_audit.search', metadata: { highRiskRead: true, filters: normalizedFilters } });
    res.status(200).json(await repo.listAdminAuditEvents({ limit: parseBoundedLimit(req.query.limit), cursor, signature, ...normalizedFilters }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function listWorkspaceAuditEvents(req: AdminAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.query.workspaceId as string | string[] | undefined);
    if (!workspaceId) {
      validationError(res, 'workspaceId is required');
      return;
    }
    const range = parseRange(req, res);
    if (!range) return;
    const category = parseStringFilter(req.query.category, 'category');
    if (category.error || (category.value && !WORKSPACE_AUDIT_CATEGORIES.includes(category.value as never))) {
      validationError(res, category.error || 'category must be a supported workspace audit category');
      return;
    }
    const filters = {
      eventType: parseStringFilter(req.query.eventType, 'eventType'),
      actorUserId: parseStringFilter(req.query.actorUserId, 'actorUserId'),
      targetType: parseStringFilter(req.query.targetType, 'targetType')
    };
    for (const parsed of Object.values(filters)) {
      if (parsed.error) {
        validationError(res, parsed.error);
        return;
      }
    }
    const normalizedFilters = {
      category: category.value as never,
      eventType: filters.eventType.value,
      actorUserId: filters.actorUserId.value,
      targetType: filters.targetType.value,
      ...range
    };
    const signature = makeQuerySignature({ workspaceId, ...normalizedFilters });
    const cursor = decodeCursor<{ occurredAt: string; eventId: string; signature: string }>(req.query.cursor, signature);
    await auditAdmin(req, { action: 'admin.workspace_audit.search', workspaceId, metadata: { highRiskRead: true, filters: normalizedFilters } });
    res.status(200).json(await repo.listWorkspaceAuditEvents(workspaceId, { limit: parseBoundedLimit(req.query.limit), cursor, signature, ...normalizedFilters }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}
