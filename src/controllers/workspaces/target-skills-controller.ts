import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { requireTargetAccess } from '../../auth/workspace-authorization.js';
import { importTargetSkillFromGithub, GithubSkillImportError } from '../../services/github-skill-import.js';
import { pageInMemory } from '../../services/snapshot-listing.js';
import {
  composeTargetSkillsCatalog,
  equalTargetSkillFiles,
  getTargetSkillBundleStorageLimitErrors,
  normalizeTargetSkillBundle,
  TARGET_SKILL_MAX_ENABLED_PER_TARGET,
  withUpdatedSkillSyncStatus
} from '../../services/target-skills.js';
import { repo } from '../../store/repository.js';
import { TargetSkillDetail, TargetSkillSource } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import {
  containsSearchText,
  CursorMismatchError,
  decodeCursor,
  makeQuerySignature,
  normalizeSearchQuery,
  parseBoundedLimit
} from '../../utils/pagination.js';
import { recordTargetSkillAudit } from './target-skill-audit.js';

function respondMissingCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with skill-management capability can modify target skills',
      retryable: false
    }
  });
}

function respondSkillBundleLimitFailure(res: Response, validationErrors: string[]): void {
  res.status(400).json({
    error: {
      code: 'INVALID_SKILL_BUNDLE_LIMIT',
      message: 'Skill bundle exceeds storage limits.',
      retryable: false,
      details: { validationErrors }
    }
  });
}

async function ensureSkillCanBeEnabled(
  targetId: string,
  skill: Pick<TargetSkillDetail, 'id' | 'validationStatus'>,
  desiredEnabled: boolean
): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  if (!desiredEnabled) {
    return { ok: true };
  }
  if (skill.validationStatus !== 'valid') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SKILL',
      message: 'Only valid skills can be enabled.'
    };
  }
  const enabledCount = await repo.countEnabledTargetSkills(targetId, skill.id);
  if (enabledCount >= TARGET_SKILL_MAX_ENABLED_PER_TARGET) {
    return {
      ok: false,
      status: 409,
      code: 'SKILL_LIMIT_REACHED',
      message: `Only ${TARGET_SKILL_MAX_ENABLED_PER_TARGET} enabled skills are allowed per target.`
    };
  }
  return { ok: true };
}

function normalizeManualSkillSource(): TargetSkillSource {
  return {
    type: 'manual',
    syncStatus: 'not_applicable'
  };
}

export async function listTargetSkills(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const allSkills = await repo.listTargetSkills(targetId);
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ q });
    const cursor = decodeCursor<{ offset?: number; signature: string }>(req.query.cursor, signature);
    const filtered = allSkills.filter((skill) =>
      containsSearchText(
        [
          skill.name,
          skill.description,
          skill.source.type,
          skill.source.repoUrl,
          skill.source.ref,
          skill.source.subpath,
          skill.validationStatus,
          ...skill.validationErrors
        ],
        q
      )
    );
    const page = pageInMemory(filtered, parseBoundedLimit(req.query.limit), cursor, signature);
    res.status(200).json(
      composeTargetSkillsCatalog({
        workspaceId,
        targetId,
        targetType: access.target.targetType,
        canEdit: access.authz.can('manage_skills'),
        items: page.items,
        nextCursor: page.nextCursor
      })
    );
  } catch (err) {
    if (err instanceof CursorMismatchError) {
      res.status(400).json({ error: { code: 'INVALID_CURSOR', message: err.message, retryable: false } });
      return;
    }
    next(err);
  }
}

export async function createTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_skills')) {
      respondMissingCapability(res);
      return;
    }

    const bundle = normalizeTargetSkillBundle(req.body.files);
    const storageLimitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
    if (storageLimitErrors.length > 0) {
      respondSkillBundleLimitFailure(res, storageLimitErrors);
      return;
    }
    const createEnabled = bundle.validationStatus === 'valid';

    if (createEnabled) {
      const enabledCount = await repo.countEnabledTargetSkills(targetId);
      if (enabledCount >= TARGET_SKILL_MAX_ENABLED_PER_TARGET) {
        res.status(409).json({
          error: {
            code: 'SKILL_LIMIT_REACHED',
            message: `Only ${TARGET_SKILL_MAX_ENABLED_PER_TARGET} enabled skills are allowed per target.`,
            retryable: false
          }
        });
        return;
      }
    }

    const skill = await repo.createTargetSkill({
      workspaceId,
      targetId,
      name: bundle.name,
      description: bundle.description,
      enabled: createEnabled,
      validationStatus: bundle.validationStatus,
      validationErrors: bundle.validationErrors,
      bundleStats: bundle.bundleStats,
      source: normalizeManualSkillSource(),
      files: bundle.files,
      actorUserId: req.auth.userId
    });

    await recordTargetSkillAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'skill.created.v1',
      operation: 'write',
      skill,
      summary: 'Target skill created'
    });
    res.status(201).json(skill);
  } catch (err) {
    next(err);
  }
}

export async function importTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_skills')) {
      respondMissingCapability(res);
      return;
    }

    const imported = await importTargetSkillFromGithub({
      repoUrl: req.body.repoUrl,
      ref: req.body.ref,
      subpath: req.body.subpath
    });
    const bundle = normalizeTargetSkillBundle(imported.files);
    const storageLimitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
    if (storageLimitErrors.length > 0) {
      respondSkillBundleLimitFailure(res, storageLimitErrors);
      return;
    }
    const importEnabled = bundle.validationStatus === 'valid';
    if (importEnabled) {
      const enabledCount = await repo.countEnabledTargetSkills(targetId);
      if (enabledCount >= TARGET_SKILL_MAX_ENABLED_PER_TARGET) {
        res.status(409).json({
          error: {
            code: 'SKILL_LIMIT_REACHED',
            message: `Only ${TARGET_SKILL_MAX_ENABLED_PER_TARGET} enabled skills are allowed per target.`,
            retryable: false
          }
        });
        return;
      }
    }

    const skill = await repo.createTargetSkill({
      workspaceId,
      targetId,
      name: bundle.name,
      description: bundle.description,
      enabled: importEnabled,
      validationStatus: bundle.validationStatus,
      validationErrors: bundle.validationErrors,
      bundleStats: bundle.bundleStats,
      source: imported.source,
      files: bundle.files,
      actorUserId: req.auth.userId
    });
    await recordTargetSkillAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'skill.imported.v1',
      operation: 'write',
      skill,
      summary: 'Target skill imported from GitHub'
    });
    res.status(201).json(skill);
  } catch (err) {
    if (err instanceof GithubSkillImportError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          retryable: false
        }
      });
      return;
    }
    next(err);
  }
}

export async function getTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const skillId = toSingleParam(req.params.skillId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }

    const skill = await repo.getTargetSkill(targetId, skillId);
    if (!skill) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }
    res.status(200).json(skill);
  } catch (err) {
    next(err);
  }
}

export async function updateTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const skillId = toSingleParam(req.params.skillId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_skills')) {
      respondMissingCapability(res);
      return;
    }

    const existing = await repo.getTargetSkill(targetId, skillId);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }

    const bundle = req.body.files ? normalizeTargetSkillBundle(req.body.files) : {
      name: existing.name,
      description: existing.description,
      files: existing.files,
      validationStatus: existing.validationStatus,
      validationErrors: existing.validationErrors,
      bundleStats: existing.bundleStats
    };
    const storageLimitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
    if (storageLimitErrors.length > 0) {
      respondSkillBundleLimitFailure(res, storageLimitErrors);
      return;
    }
    const desiredEnabled = req.body.enabled ?? existing.enabled;
    const bundleChanged = req.body.files ? !equalTargetSkillFiles(existing.files, bundle.files) : false;
    const source = req.body.files
      ? withUpdatedSkillSyncStatus(existing.source, bundleChanged, 'edit')
      : existing.source;
    const candidate: TargetSkillDetail = {
      ...existing,
      name: bundle.name,
      description: bundle.description,
      enabled: desiredEnabled,
      validationStatus: bundle.validationStatus,
      validationErrors: bundle.validationErrors,
      bundleStats: bundle.bundleStats,
      source,
      files: bundle.files
    };
    const enableCheck = await ensureSkillCanBeEnabled(targetId, candidate, desiredEnabled);
    if (!enableCheck.ok) {
      res.status(enableCheck.status).json({
        error: {
          code: enableCheck.code,
          message: enableCheck.message,
          retryable: false
        }
      });
      return;
    }

    const updated = await repo.updateTargetSkill({
      skillId,
      workspaceId,
      targetId,
      name: candidate.name,
      description: candidate.description,
      enabled: desiredEnabled,
      validationStatus: candidate.validationStatus,
      validationErrors: candidate.validationErrors,
      bundleStats: candidate.bundleStats,
      source: candidate.source,
      files: candidate.files,
      actorUserId: req.auth.userId
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }

    await recordTargetSkillAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType:
        existing.enabled !== updated.enabled
          ? updated.enabled ? 'skill.enabled.v1' : 'skill.disabled.v1'
          : 'skill.updated.v1',
      operation: 'write',
      skill: updated,
      summary:
        existing.enabled !== updated.enabled
          ? updated.enabled ? 'Target skill enabled' : 'Target skill disabled'
          : 'Target skill updated',
      metadata: {
        bundleChanged
      }
    });
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const skillId = toSingleParam(req.params.skillId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_skills')) {
      respondMissingCapability(res);
      return;
    }

    const existing = await repo.getTargetSkill(targetId, skillId);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }
    await repo.deleteTargetSkill(targetId, skillId);
    await recordTargetSkillAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'skill.deleted.v1',
      operation: 'write',
      skill: existing,
      summary: 'Target skill deleted'
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function reimportTargetSkillForTarget(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const targetId = toSingleParam(req.params.targetId);
    const skillId = toSingleParam(req.params.skillId);
    const access = await requireTargetAccess(req, res, workspaceId, targetId);
    if (!access) {
      return;
    }
    if (!access.authz.can('manage_skills')) {
      respondMissingCapability(res);
      return;
    }

    const existing = await repo.getTargetSkill(targetId, skillId);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }
    if (existing.source.type !== 'git_import') {
      res.status(400).json({
        error: {
          code: 'INVALID_SKILL_SOURCE',
          message: 'Only GitHub-imported skills can be reimported.',
          retryable: false
        }
      });
      return;
    }
    if (existing.source.syncStatus === 'modified' && !req.body.force) {
      res.status(409).json({
        error: {
          code: 'REIMPORT_CONFIRMATION_REQUIRED',
          message: 'This imported skill has local changes. Reimport with force=true to overwrite the local bundle.',
          retryable: false
        }
      });
      return;
    }

    const imported = await importTargetSkillFromGithub({
      repoUrl: existing.source.repoUrl || '',
      ref: existing.source.ref,
      subpath: existing.source.subpath
    });
    const bundle = normalizeTargetSkillBundle(imported.files);
    const storageLimitErrors = getTargetSkillBundleStorageLimitErrors(bundle);
    if (storageLimitErrors.length > 0) {
      respondSkillBundleLimitFailure(res, storageLimitErrors);
      return;
    }
    const desiredEnabled = bundle.validationStatus === 'valid' ? existing.enabled : false;
    const updated = await repo.updateTargetSkill({
      skillId,
      workspaceId,
      targetId,
      name: bundle.name,
      description: bundle.description,
      enabled: desiredEnabled,
      validationStatus: bundle.validationStatus,
      validationErrors: bundle.validationErrors,
      bundleStats: bundle.bundleStats,
      source: withUpdatedSkillSyncStatus(imported.source, true, 'reimport'),
      files: bundle.files,
      actorUserId: req.auth.userId
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } });
      return;
    }

    await recordTargetSkillAudit({
      workspaceId,
      targetId,
      targetType: access.target.targetType,
      actorUserId: req.auth.userId,
      eventType: 'skill.reimported.v1',
      operation: 'write',
      skill: updated,
      summary: 'Target skill reimported from GitHub',
      metadata: {
        locallyModified: existing.source.syncStatus === 'modified',
        autoDisabled: existing.enabled && !updated.enabled && updated.validationStatus !== 'valid'
      }
    });
    res.status(200).json(updated);
  } catch (err) {
    if (err instanceof GithubSkillImportError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          retryable: false
        }
      });
      return;
    }
    next(err);
  }
}
