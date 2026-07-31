import { Response } from 'express';
import { TARGET_SKILL_MAX_ENABLED_PER_TARGET } from '../../services/target-skills.js';
import { repo } from '../../store/repository.js';
import { TargetSkillDetail, TargetSkillSource } from '../../types/domain.js';

export function respondMissingSkillCapability(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Only workspace roles with skill-management capability can modify target skills',
      retryable: false
    }
  });
}

export function respondSkillBundleLimitFailure(res: Response, validationErrors: string[]): void {
  res.status(400).json({
    error: {
      code: 'INVALID_SKILL_BUNDLE_LIMIT',
      message: 'Skill bundle exceeds storage limits.',
      retryable: false,
      details: { validationErrors }
    }
  });
}

export async function ensureTargetSkillCanBeEnabled(
  targetId: string,
  skill: Pick<TargetSkillDetail, 'id' | 'validationStatus'>,
  desiredEnabled: boolean
): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  if (!desiredEnabled) return { ok: true };
  if (skill.validationStatus !== 'valid') {
    return { ok: false, status: 400, code: 'INVALID_SKILL', message: 'Only valid skills can be enabled.' };
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

export function normalizeManualSkillSource(): TargetSkillSource {
  return { type: 'manual', syncStatus: 'not_applicable' };
}

export function normalizeGitImportSource(input: {
  provider: 'github' | 'gitlab';
  repoUrl: string;
  apiBaseUrl?: string;
  ref: string;
  subpath?: string;
  commitSha?: string;
}): TargetSkillSource {
  return {
    type: 'git_import',
    provider: input.provider,
    repoUrl: input.repoUrl,
    ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
    ref: input.ref,
    ...(input.subpath ? { subpath: input.subpath } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    syncStatus: 'current'
  };
}

export function gitImportSourceMatches(left: TargetSkillSource, right: TargetSkillSource): boolean {
  return left.type === 'git_import' &&
    right.type === 'git_import' &&
    left.provider === right.provider &&
    left.repoUrl === right.repoUrl &&
    left.ref === right.ref &&
    (left.subpath || '') === (right.subpath || '');
}

export function targetSkillImportEnabled(validationStatus: string): boolean {
  return validationStatus === 'valid';
}
