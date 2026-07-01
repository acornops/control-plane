import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { config } from '../../config.js';
import { recordTargetInsightsAudit } from '../../services/target-insights/audit.js';
import { serializeTargetInsightsBundle } from '../../services/target-insights/okf.js';
import { repo } from '../../store/repository.js';
import { TargetInsightsEntryStatus } from '../../types/target-insights.js';
import { toSingleParam } from '../../utils/params.js';

function ensureTargetInsightsEnabled(res: Response): boolean {
  if (config.TARGET_INSIGHTS_ENABLED) {
    return true;
  }
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target Insights is not enabled', retryable: false } });
  return false;
}

function requireManageTargetInsights(access: Awaited<ReturnType<typeof requireTargetAccess>>, res: Response): boolean {
  if (access?.authz.can('manage_target_insights')) {
    return true;
  }
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with target insights management capability can modify Target Insights',
      retryable: false
    }
  });
  return false;
}

function parseStatus(value: unknown): TargetInsightsEntryStatus | undefined {
  return value === 'active' || value === 'pending' || value === 'archived' ? value : undefined;
}

function entryResponse(entry: Awaited<ReturnType<typeof repo.getTargetInsightsEntry>>) {
  return entry;
}

export async function listTargetInsightsEntries(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const entries = await repo.listTargetInsightsEntries(workspaceId, targetId, {
      status: parseStatus(req.query.status),
      q: toSingleParam(req.query.q as string | string[] | undefined),
      limit: Number(req.query.limit || 100)
    });
    res.status(200).json({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      permissions: {
        canEdit: access.authz.can('manage_target_insights')
      },
      items: entries
    });
  } catch (err) {
    next(err);
  }
}

export async function createTargetInsightsEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageTargetInsights(access, res)) return;
    const entry = await repo.createTargetInsightsEntry({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      title: req.body.title,
      status: req.body.status,
      bodyMarkdown: req.body.bodyMarkdown,
      frontmatter: req.body.frontmatter,
      tags: req.body.tags,
      signals: req.body.signals,
      scope: req.body.scope,
      evidenceSummary: req.body.evidenceSummary,
      observationCount: req.body.observationCount,
      confidence: req.body.confidence
    });
    await recordTargetInsightsAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'target_insights.entry.created.v1',
      objectId: entry.id,
      objectName: entry.title,
      summary: 'Target Insights entry created',
      metadata: { status: entry.status }
    });
    res.status(201).json(entryResponse(entry));
  } catch (err) {
    next(err);
  }
}

export async function updateTargetInsightsEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const entryId = toSingleParam(req.params.entryId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageTargetInsights(access, res)) return;
    const entry = await repo.updateTargetInsightsEntry(workspaceId, targetId, entryId, req.body);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target Insights entry not found', retryable: false } });
      return;
    }
    await recordTargetInsightsAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'target_insights.entry.updated.v1',
      objectId: entry.id,
      objectName: entry.title,
      summary: 'Target Insights entry updated',
      metadata: { status: entry.status }
    });
    res.status(200).json(entryResponse(entry));
  } catch (err) {
    next(err);
  }
}

async function setEntryStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  status: TargetInsightsEntryStatus,
  eventType: string,
  summary: string
): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const entryId = toSingleParam(req.params.entryId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageTargetInsights(access, res)) return;
    const entry = await repo.updateTargetInsightsEntry(workspaceId, targetId, entryId, { status });
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target Insights entry not found', retryable: false } });
      return;
    }
    await recordTargetInsightsAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType,
      objectId: entry.id,
      objectName: entry.title,
      summary,
      metadata: { status }
    });
    res.status(200).json(entryResponse(entry));
  } catch (err) {
    next(err);
  }
}

export function promoteTargetInsightsEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return setEntryStatus(req, res, next, 'active', 'target_insights.entry.promoted.v1', 'Target Insights entry promoted');
}

export function archiveTargetInsightsEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return setEntryStatus(req, res, next, 'archived', 'target_insights.entry.archived.v1', 'Target Insights entry archived');
}

export async function resetTargetInsights(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageTargetInsights(access, res)) return;
    const result = await repo.resetTargetInsights(workspaceId, targetId);
    await recordTargetInsightsAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'target_insights.reset.v1',
      objectId: targetId,
      summary: 'Target Insights reset',
      metadata: result
    });
    res.status(200).json({ status: 'ok', ...result });
  } catch (err) {
    next(err);
  }
}

export async function listTargetInsightsActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const events = await repo.listWorkspaceAuditEvents(workspaceId, {
      category: 'insights',
      metadataTargetId: targetId,
      limit: Number(req.query.limit || 50)
    });
    res.status(200).json({
      workspaceId,
      targetId,
      items: events.items
    });
  } catch (err) {
    next(err);
  }
}

export async function exportTargetInsights(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureTargetInsightsEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const entries = await repo.listTargetInsightsEntries(workspaceId, targetId, { limit: 200 });
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="target-insights-${targetId}.md"`);
    res.status(200).send(serializeTargetInsightsBundle(entries));
  } catch (err) {
    next(err);
  }
}
