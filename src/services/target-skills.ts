import { listConfiguredRoleTemplates } from '../auth/authorization.js';
import {
  KUBERNETES_TARGET_TYPE,
  TargetSkillDetail,
  TargetSkillFile,
  TargetSkillSource,
  TargetSkillsCatalog,
  TargetSkillSummary,
  TargetType
} from '../types/domain.js';
export {
  getSkillBundleStorageLimitErrors as getTargetSkillBundleStorageLimitErrors,
  normalizeSkillBundle as normalizeTargetSkillBundle,
  SKILL_BUNDLE_MAX_FILES as TARGET_SKILL_MAX_FILES,
  SKILL_BUNDLE_MAX_FILE_BYTES as TARGET_SKILL_MAX_FILE_BYTES,
  SKILL_BUNDLE_MAX_TOTAL_BYTES as TARGET_SKILL_MAX_TOTAL_BYTES
} from './skill-bundles.js';

export const TARGET_SKILL_MAX_ENABLED_PER_TARGET = 10;

export function getTargetSkillEditableRoles(): string[] {
  return listConfiguredRoleTemplates()
    .filter((role) => role.capabilities.includes('manage_skills'))
    .map((role) => role.key);
}

export function composeTargetSkillsCatalog(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  canEdit: boolean;
  items: TargetSkillSummary[];
  nextCursor?: string;
}): TargetSkillsCatalog {
  return {
    workspaceId: params.workspaceId,
    targetId: params.targetId,
    targetType: params.targetType,
    ...(params.targetType === KUBERNETES_TARGET_TYPE ? { clusterId: params.targetId } : {}),
    permissions: {
      canEdit: params.canEdit,
      editableRoles: getTargetSkillEditableRoles()
    },
    items: params.items,
    nextCursor: params.nextCursor
  };
}

export function equalTargetSkillFiles(left: TargetSkillFile[], right: TargetSkillFile[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].path !== right[index].path || left[index].content !== right[index].content) {
      return false;
    }
  }
  return true;
}

export function withUpdatedSkillSyncStatus(
  source: TargetSkillSource,
  bundleChanged: boolean,
  mode: 'edit' | 'reimport'
): TargetSkillSource {
  if (source.type !== 'git_import') {
    return { ...source, syncStatus: 'not_applicable' };
  }
  if (mode === 'reimport') {
    return { ...source, syncStatus: 'current' };
  }
  if (!bundleChanged) {
    return source;
  }
  return { ...source, syncStatus: 'modified' };
}
