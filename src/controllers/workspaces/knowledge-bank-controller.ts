import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { config } from '../../config.js';
import { recordKnowledgeBankAudit } from '../../services/knowledge-bank/audit.js';
import { serializeKnowledgeBankBundle } from '../../services/knowledge-bank/okf.js';
import { repo } from '../../store/repository.js';
import { KnowledgeBankEntryStatus } from '../../types/knowledge-bank.js';
import { toSingleParam } from '../../utils/params.js';

function ensureKnowledgeBankEnabled(res: Response): boolean {
  if (config.KNOWLEDGE_BANK_ENABLED) {
    return true;
  }
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge Bank is not enabled', retryable: false } });
  return false;
}

function requireManageKnowledgeBank(access: Awaited<ReturnType<typeof requireTargetAccess>>, res: Response): boolean {
  if (access?.authz.can('manage_knowledge_bank')) {
    return true;
  }
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with knowledge bank management capability can modify Knowledge Bank',
      retryable: false
    }
  });
  return false;
}

function parseStatus(value: unknown): KnowledgeBankEntryStatus | undefined {
  return value === 'active' || value === 'pending' || value === 'archived' ? value : undefined;
}

function entryResponse(entry: Awaited<ReturnType<typeof repo.getKnowledgeBankEntry>>) {
  return entry;
}

export async function listKnowledgeBankEntries(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const entries = await repo.listKnowledgeBankEntries(workspaceId, targetId, {
      status: parseStatus(req.query.status),
      q: toSingleParam(req.query.q as string | string[] | undefined),
      limit: Number(req.query.limit || 100)
    });
    res.status(200).json({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      permissions: {
        canEdit: access.authz.can('manage_knowledge_bank')
      },
      items: entries
    });
  } catch (err) {
    next(err);
  }
}

export async function createKnowledgeBankEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageKnowledgeBank(access, res)) return;
    const entry = await repo.createKnowledgeBankEntry({
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
    await recordKnowledgeBankAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'knowledge.entry.created.v1',
      objectId: entry.id,
      objectName: entry.title,
      summary: 'Knowledge Bank entry created',
      metadata: { status: entry.status }
    });
    res.status(201).json(entryResponse(entry));
  } catch (err) {
    next(err);
  }
}

export async function updateKnowledgeBankEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const entryId = toSingleParam(req.params.entryId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageKnowledgeBank(access, res)) return;
    const entry = await repo.updateKnowledgeBankEntry(workspaceId, targetId, entryId, req.body);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge Bank entry not found', retryable: false } });
      return;
    }
    await recordKnowledgeBankAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'knowledge.entry.updated.v1',
      objectId: entry.id,
      objectName: entry.title,
      summary: 'Knowledge Bank entry updated',
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
  status: KnowledgeBankEntryStatus,
  eventType: string,
  summary: string
): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const entryId = toSingleParam(req.params.entryId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageKnowledgeBank(access, res)) return;
    const entry = await repo.updateKnowledgeBankEntry(workspaceId, targetId, entryId, { status });
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge Bank entry not found', retryable: false } });
      return;
    }
    await recordKnowledgeBankAudit({
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

export function promoteKnowledgeBankEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return setEntryStatus(req, res, next, 'active', 'knowledge.entry.promoted.v1', 'Knowledge Bank entry promoted');
}

export function archiveKnowledgeBankEntry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  return setEntryStatus(req, res, next, 'archived', 'knowledge.entry.archived.v1', 'Knowledge Bank entry archived');
}

export async function resetKnowledgeBank(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access || !requireManageKnowledgeBank(access, res)) return;
    const result = await repo.resetKnowledgeBank(workspaceId, targetId);
    await recordKnowledgeBankAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'knowledge.bank.reset.v1',
      objectId: targetId,
      summary: 'Knowledge Bank reset',
      metadata: result
    });
    res.status(200).json({ status: 'ok', ...result });
  } catch (err) {
    next(err);
  }
}

export async function listKnowledgeBankActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const events = await repo.listWorkspaceAuditEvents(workspaceId, {
      category: 'knowledge',
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

export async function exportKnowledgeBank(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!ensureKnowledgeBankEnabled(res)) return;
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) return;
    const entries = await repo.listKnowledgeBankEntries(workspaceId, targetId, { limit: 200 });
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="knowledge-bank-${targetId}.md"`);
    res.status(200).send(serializeKnowledgeBankBundle(entries));
  } catch (err) {
    next(err);
  }
}
