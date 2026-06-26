import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireWorkspaceDataRead } from '../../auth/workspace-authorization.js';
import { repo } from '../../store/repository.js';
import { isTargetType, TARGET_TYPE_DISPLAY_LIST } from '../../types/domain.js';
import type { TargetIssueStatus } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';

const issueStatuses = new Set(['active', 'recovering', 'resolved', 'all']);
const issueSeverities = new Set(['critical', 'warning', 'info']);

function parseIssueStatus(value: unknown): TargetIssueStatus | 'all' | undefined {
  const raw = toSingleParam(value as string | string[] | undefined);
  if (!raw) return undefined;
  return issueStatuses.has(raw) ? raw as TargetIssueStatus | 'all' : undefined;
}

function parseSeverity(value: unknown): string | undefined {
  const raw = toSingleParam(value as string | string[] | undefined);
  if (!raw) return undefined;
  return issueSeverities.has(raw) ? raw : undefined;
}

function invalidFilter(res: Response, message: string): void {
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, retryable: false } });
}

export async function listWorkspaceIssues(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;

    const rawStatus = toSingleParam(req.query.status as string | string[] | undefined);
    const status = parseIssueStatus(rawStatus);
    if (rawStatus && !status) {
      invalidFilter(res, 'status must be one of: active, recovering, resolved, all');
      return;
    }
    const rawSeverity = toSingleParam(req.query.severity as string | string[] | undefined);
    const severity = parseSeverity(rawSeverity);
    if (rawSeverity && !severity) {
      invalidFilter(res, 'severity must be one of: critical, warning, info');
      return;
    }
    const rawTargetType = toSingleParam(req.query.targetType as string | string[] | undefined);
    if (rawTargetType && !isTargetType(rawTargetType)) {
      invalidFilter(res, `targetType must be one of: ${TARGET_TYPE_DISPLAY_LIST}`);
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const filters = {
      q,
      status,
      severity,
      targetType: rawTargetType || undefined,
      targetId: toSingleParam(req.query.targetId as string | string[] | undefined),
      namespace: toSingleParam(req.query.namespace as string | string[] | undefined)
    };
    const signature = makeQuerySignature(filters);
    const cursor = decodeCursor<{ statusRank: number; severityRank: number; lastSeenAt: string; issueId: string; signature: string }>(
      req.query.cursor,
      signature
    );
    const page = await repo.listWorkspaceIssues(workspaceId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      signature,
      ...filters
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function listTargetIssues(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;

    const rawStatus = toSingleParam(req.query.status as string | string[] | undefined);
    const status = parseIssueStatus(rawStatus);
    if (rawStatus && !status) {
      invalidFilter(res, 'status must be one of: active, recovering, resolved, all');
      return;
    }
    const rawSeverity = toSingleParam(req.query.severity as string | string[] | undefined);
    const severity = parseSeverity(rawSeverity);
    if (rawSeverity && !severity) {
      invalidFilter(res, 'severity must be one of: critical, warning, info');
      return;
    }
    const q = normalizeSearchQuery(req.query.q);
    const filters = {
      q,
      status,
      severity,
      namespace: toSingleParam(req.query.namespace as string | string[] | undefined)
    };
    const signature = makeQuerySignature({ targetId, ...filters });
    const cursor = decodeCursor<{ statusRank: number; severityRank: number; lastSeenAt: string; issueId: string; signature: string }>(
      req.query.cursor,
      signature
    );
    const page = await repo.listTargetIssues(workspaceId, targetId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      signature,
      ...filters
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function getTargetIssue(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const issueId = toSingleParam(req.params.issueId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const issue = await repo.getTargetIssue(workspaceId, issueId);
    if (!issue) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Issue not found', retryable: false } });
      return;
    }
    res.status(200).json(issue);
  } catch (err) {
    next(err);
  }
}

export async function listTargetIssueObservations(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const issueId = toSingleParam(req.params.issueId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId))) return;
    const issue = await repo.getTargetIssue(workspaceId, issueId);
    if (!issue) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Issue not found', retryable: false } });
      return;
    }
    const signature = makeQuerySignature({ issueId });
    const cursor = decodeCursor<{ snapshotTs: string; observationId: string; signature: string }>(req.query.cursor, signature);
    const page = await repo.listTargetIssueObservations(workspaceId, issueId, {
      limit: parseBoundedLimit(req.query.limit),
      cursor,
      signature
    });
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}
