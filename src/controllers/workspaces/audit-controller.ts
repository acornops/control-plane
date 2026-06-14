import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceCapability } from '../../auth/workspace-authorization.js';
import { repo } from '../../store/repository.js';
import { WORKSPACE_AUDIT_CATEGORIES, WorkspaceAuditCategory, WorkspaceAuditEvent } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  parseBoundedLimit
} from '../../utils/pagination.js';

function parseAuditCategory(value: string): WorkspaceAuditCategory | undefined {
  return WORKSPACE_AUDIT_CATEGORIES.includes(value as WorkspaceAuditCategory)
    ? value as WorkspaceAuditCategory
    : undefined;
}

function parseIsoDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAuditStringFilter(
  value: string,
  name: string
): { value?: string; error?: string } {
  if (!value) return {};
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: `${name} must not be blank` };
  }
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { error: `${name} must be a valid audit filter value` };
  }
  return { value: trimmed };
}

function validationError(message: string): { error: { code: 'VALIDATION_ERROR'; message: string; retryable: false } } {
  return { error: { code: 'VALIDATION_ERROR', message, retryable: false } };
}

function serializeAuditEvent(event: WorkspaceAuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    operation: event.operation,
    actor: event.actor,
    object: event.object,
    summary: event.summary,
    metadata: event.metadata,
    occurredAt: event.occurredAt
  };
}

export async function listWorkspaceAuditEvents(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'read_audit_log',
        'Only workspace roles with audit-log read capability can read audit logs',
        'No access to workspace audit logs'
      ))
    ) {
      return;
    }

    const categoryParam = toSingleParam(req.query.category as string | string[] | undefined);
    const fromParam = toSingleParam(req.query.from as string | string[] | undefined);
    const toParam = toSingleParam(req.query.to as string | string[] | undefined);
    const category = parseAuditCategory(categoryParam);
    const from = parseIsoDate(fromParam);
    const to = parseIsoDate(toParam);
    if (categoryParam && !category) {
      res.status(400).json(validationError('category must be a supported workspace audit category'));
      return;
    }
    if (fromParam && !from) {
      res.status(400).json(validationError('from must be a valid date-time value'));
      return;
    }
    if (toParam && !to) {
      res.status(400).json(validationError('to must be a valid date-time value'));
      return;
    }
    if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
      res.status(400).json(validationError('from must be earlier than or equal to to'));
      return;
    }

    const eventType = parseAuditStringFilter(
      toSingleParam(req.query.eventType as string | string[] | undefined),
      'eventType'
    );
    const actorUserId = parseAuditStringFilter(
      toSingleParam(req.query.actorUserId as string | string[] | undefined),
      'actorUserId'
    );
    const objectType = parseAuditStringFilter(
      toSingleParam(req.query.objectType as string | string[] | undefined),
      'objectType'
    );
    for (const parsedFilter of [eventType, actorUserId, objectType]) {
      if (parsedFilter.error) {
        res.status(400).json(validationError(parsedFilter.error));
        return;
      }
    }

    const filters = {
      category,
      eventType: eventType.value,
      actorUserId: actorUserId.value,
      objectType: objectType.value,
      from,
      to
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ occurredAt: string; eventId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listWorkspaceAuditEvents(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      ...filters,
      signature
    });
    res.status(200).json({
      items: page.items.map(serializeAuditEvent),
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
