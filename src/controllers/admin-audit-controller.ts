import { NextFunction, Response } from 'express';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { repo } from '../store/repository.js';
import { WORKSPACE_AUDIT_CATEGORIES } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { CursorMismatchError, decodeCursor, makeQuerySignature, parseBoundedLimit } from '../utils/pagination.js';
import { parseIsoDateQuery, parseStringFilter, validationError } from './admin-controller-common.js';

const mutationActions = (...actions: string[]): string[] => actions.flatMap((action) => [action, `${action}.request`]);

interface AdminAuditActionFilter {
  actions: string[];
  subjectIds?: string[];
}

const mutationFilter = (actions: string[], subjectIds?: string[]): AdminAuditActionFilter => ({
  actions: mutationActions(...actions),
  ...(subjectIds ? { subjectIds } : {})
});

const ADMIN_AUDIT_ACTION_GROUPS = {
  platform_settings_modified: [
    mutationFilter(
      ['admin.system.setting.update', 'admin.system.setting.reset'],
      ['member_discovery', 'user_sign_in_methods', 'kubernetes_rbac_additions']
    )
  ],
  llm_provider_defaults_modified: [
    mutationFilter(['admin.system.llm_provider_default.update', 'admin.system.llm_provider_default.delete']),
    mutationFilter(['admin.system.setting.update', 'admin.system.setting.reset'], ['ai_policy'])
  ],
  workspace_defaults_modified: [
    mutationFilter(['admin.system.workspace_default.create', 'admin.system.workspace_default.update', 'admin.system.workspace_default.delete'])
  ],
  workspace_status_modified: [mutationFilter(['admin.workspace.suspend', 'admin.workspace.restore'])],
  workspace_access_modified: [
    mutationFilter(['admin.workspace.member.add', 'admin.workspace.member.delete', 'admin.workspace.member.role.update', 'admin.member.role.update'])
  ]
} as const;

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
      adminActorSubject: parseStringFilter(req.query.adminActorSubject, 'adminActorSubject'),
      action: parseStringFilter(req.query.action, 'action'),
      actionGroup: parseStringFilter(req.query.actionGroup, 'actionGroup'),
      workspaceId: parseStringFilter(req.query.workspaceId, 'workspaceId'),
      workspaceQuery: parseStringFilter(req.query.workspaceQuery, 'workspaceQuery'),
      targetType: parseStringFilter(req.query.targetType, 'targetType'),
      targetId: parseStringFilter(req.query.targetId, 'targetId')
    };
    for (const parsed of Object.values(filters)) {
      if (parsed.error) {
        validationError(res, parsed.error);
        return;
      }
    }
    if (filters.action.value && filters.actionGroup.value) {
      validationError(res, 'action and actionGroup cannot be combined');
      return;
    }
    const groupedFilters = filters.actionGroup.value ? ADMIN_AUDIT_ACTION_GROUPS[filters.actionGroup.value as keyof typeof ADMIN_AUDIT_ACTION_GROUPS] : undefined;
    if (filters.actionGroup.value && !groupedFilters) {
      validationError(res, `actionGroup must be one of ${Object.keys(ADMIN_AUDIT_ACTION_GROUPS).join(', ')}`);
      return;
    }
    const normalizedFilters = {
      adminTokenId: filters.adminTokenId.value,
      adminActorSubject: filters.adminActorSubject.value,
      action: filters.action.value,
      actionGroup: filters.actionGroup.value,
      outcome: outcome.value as 'success' | 'failure' | undefined,
      workspaceId: filters.workspaceId.value,
      workspaceQuery: filters.workspaceQuery.value,
      targetType: filters.targetType.value,
      targetId: filters.targetId.value,
      ...range
    };
    const signature = makeQuerySignature(normalizedFilters);
    const cursor = decodeCursor<{ occurredAt: string; eventId: string; signature: string }>(req.query.cursor, signature);
    const actionFilters = groupedFilters?.map((filter) => ({
      actions: [...filter.actions],
      ...(filter.subjectIds ? { subjectIds: [...filter.subjectIds] } : {})
    }));
    res.status(200).json(await repo.listAdminAuditEvents({ limit: parseBoundedLimit(req.query.limit), cursor, signature, actionFilters, ...normalizedFilters }));
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
      objectType: parseStringFilter(req.query.objectType, 'objectType')
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
      objectType: filters.objectType.value,
      ...range
    };
    const signature = makeQuerySignature({ workspaceId, ...normalizedFilters });
    const cursor = decodeCursor<{ occurredAt: string; eventId: string; signature: string }>(req.query.cursor, signature);
    res.status(200).json(await repo.listWorkspaceAuditEvents(workspaceId, { limit: parseBoundedLimit(req.query.limit), cursor, signature, ...normalizedFilters }));
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}
