import type { TargetType } from './domain.js';

export type TargetSkillSourceType = 'manual' | 'git_import';
export type TargetSkillValidationStatus = 'valid' | 'invalid';
export type TargetSkillSyncStatus = 'not_applicable' | 'current' | 'modified';

export interface TargetSkillBundleStats {
  fileCount: number;
  totalBytes: number;
}

export interface TargetSkillFile {
  path: string;
  content: string;
  sizeBytes: number;
}

export interface TargetSkillSource {
  type: TargetSkillSourceType;
  repoUrl?: string;
  ref?: string;
  subpath?: string;
  commitSha?: string;
  syncStatus: TargetSkillSyncStatus;
}

export interface TargetSkillSummary {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  name: string;
  description: string;
  enabled: boolean;
  validationStatus: TargetSkillValidationStatus;
  validationErrors: string[];
  bundleStats: TargetSkillBundleStats;
  source: TargetSkillSource;
  createdAt: string;
  updatedAt: string;
}

export interface TargetSkillDetail extends TargetSkillSummary {
  files: TargetSkillFile[];
}

export interface TargetSkillsCatalog {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  permissions: {
    canEdit: boolean;
    editableRoles: ReadonlyArray<string>;
  };
  items: TargetSkillSummary[];
  nextCursor?: string;
}
