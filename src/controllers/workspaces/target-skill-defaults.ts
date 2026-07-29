import { normalizeTargetSkillBundle } from '../../services/target-skills.js';
import {
  getInheritedWorkspaceDefault,
  workspaceDefaultIdFromInheritedId
} from '../../services/workspace-default-resolution.js';
import { repo } from '../../store/repository.js';
import { TargetSkillDetail, TargetType } from '../../types/domain.js';
import { recordTargetSkillAudit } from './target-skill-audit.js';

type EnableCheck = (targetId: string, skill: Pick<TargetSkillDetail, 'id' | 'validationStatus'>, enabled: boolean) =>
  Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }>;

export function withSkillProvenance(skill: TargetSkillDetail) {
  return { ...skill, inherited: false };
}

export async function inheritedTargetSkillDetail(
  skillId: string,
  targetType: TargetType,
  workspaceId: string,
  targetId: string
) {
  const inherited = await getInheritedWorkspaceDefault(workspaceId, skillId, 'skill', targetType);
  if (!inherited || inherited.source.type !== 'git') return null;
  return {
    id: skillId,
    workspaceId,
    targetId,
    targetType,
    ...(targetType === 'kubernetes' ? { clusterId: targetId } : {}),
    name: inherited.name,
    description: inherited.description,
    enabled: false,
    validationStatus: 'valid',
    validationErrors: [],
    bundleStats: {
      fileCount: inherited.files?.length || 0,
      totalBytes: inherited.files?.reduce((sum, file) => sum + file.sizeBytes, 0) || 0
    },
    source: {
      type: 'git_import',
      provider: inherited.source.provider,
      repoUrl: inherited.source.repoUrl,
      ref: inherited.source.ref,
      subpath: inherited.source.subpath,
      commitSha: inherited.source.commitSha,
      syncStatus: 'current'
    },
    files: inherited.files || [],
    inherited: true,
    createdAt: inherited.initializedAt,
    updatedAt: inherited.initializedAt
  };
}

export async function materializeInheritedTargetSkill(args: {
  skillId: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  actorUserId: string;
  body: Record<string, unknown>;
  ensureCanEnable: EnableCheck;
}): Promise<{ status: number; body: unknown } | null> {
  if (!workspaceDefaultIdFromInheritedId(args.skillId)) return null;
  if (args.body.enabled !== true || Object.keys(args.body).some((key) => key !== 'enabled')) {
    return immutable(400, 'A platform default can only be enabled; its source is managed by a platform administrator.');
  }
  const inherited = await getInheritedWorkspaceDefault(
    args.workspaceId,
    args.skillId,
    'skill',
    args.targetType
  );
  if (!inherited || inherited.source.type !== 'git') {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Target skill not found', retryable: false } } };
  }
  const bundle = normalizeTargetSkillBundle((inherited.files || []).map((file) => ({
    path: file.path,
    content: file.content
  })));
  const enableCheck = await args.ensureCanEnable(args.targetId, {
    id: args.skillId,
    validationStatus: bundle.validationStatus
  }, true);
  if (!enableCheck.ok) {
    return {
      status: enableCheck.status,
      body: { error: { code: enableCheck.code, message: enableCheck.message, retryable: false } }
    };
  }
  const materialized = await repo.createTargetSkill({
    workspaceId: args.workspaceId,
    targetId: args.targetId,
    name: inherited.name,
    description: inherited.description,
    enabled: true,
    validationStatus: bundle.validationStatus,
    validationErrors: bundle.validationErrors,
    bundleStats: bundle.bundleStats,
    source: {
      type: 'git_import',
      provider: inherited.source.provider,
      repoUrl: inherited.source.repoUrl,
      ref: inherited.source.ref,
      subpath: inherited.source.subpath,
      commitSha: inherited.source.commitSha,
      syncStatus: 'current'
    },
    files: bundle.files,
    actorUserId: args.actorUserId
  });
  await recordTargetSkillAudit({
    workspaceId: args.workspaceId,
    targetId: args.targetId,
    targetType: args.targetType,
    actorUserId: args.actorUserId,
    eventType: 'skill.created.v1',
    operation: 'write',
    skill: materialized,
    summary: 'Platform default skill enabled'
  });
  return {
    status: 200,
    body: withSkillProvenance(materialized)
  };
}

function immutable(status: number, message: string) {
  return {
    status,
    body: { error: { code: 'PLATFORM_DEFAULT_SOURCE_IMMUTABLE', message, retryable: false } }
  };
}
