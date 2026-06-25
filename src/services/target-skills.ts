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

export const TARGET_SKILL_MAX_ENABLED_PER_TARGET = 10;
export const TARGET_SKILL_MAX_FILES = 16;
export const TARGET_SKILL_MAX_TOTAL_BYTES = 128 * 1024;
export const TARGET_SKILL_MAX_FILE_BYTES = 32 * 1024;

export interface TargetSkillBundleFileInput {
  path: string;
  content: string;
}

export interface NormalizedTargetSkillBundle {
  name: string;
  description: string;
  files: TargetSkillFile[];
  validationStatus: 'valid' | 'invalid';
  validationErrors: string[];
  bundleStats: {
    fileCount: number;
    totalBytes: number;
  };
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
}

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

export function normalizeTargetSkillBundle(files: TargetSkillBundleFileInput[]): NormalizedTargetSkillBundle {
  const validationErrors: string[] = [];
  const normalizedByPath = new Map<string, TargetSkillFile>();
  let totalBytes = 0;

  if (!Array.isArray(files) || files.length === 0) {
    validationErrors.push('Skill bundle must include at least one Markdown file.');
  }
  if (files.length > TARGET_SKILL_MAX_FILES) {
    validationErrors.push(`Skill bundle can include at most ${TARGET_SKILL_MAX_FILES} Markdown files.`);
  }

  for (const entry of files) {
    const normalizedPath = normalizeBundlePath(entry.path);
    if (!normalizedPath.ok) {
      validationErrors.push(normalizedPath.error);
      continue;
    }
    if (normalizedByPath.has(normalizedPath.path)) {
      validationErrors.push(`Duplicate skill file path "${normalizedPath.path}".`);
      continue;
    }
    const content = typeof entry.content === 'string' ? entry.content : '';
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > TARGET_SKILL_MAX_FILE_BYTES) {
      validationErrors.push(`Skill file "${normalizedPath.path}" exceeds the ${TARGET_SKILL_MAX_FILE_BYTES} byte limit.`);
    }
    totalBytes += sizeBytes;
    normalizedByPath.set(normalizedPath.path, {
      path: normalizedPath.path,
      content,
      sizeBytes
    });
  }

  if (totalBytes > TARGET_SKILL_MAX_TOTAL_BYTES) {
    validationErrors.push(`Skill bundle exceeds the ${TARGET_SKILL_MAX_TOTAL_BYTES} byte limit.`);
  }

  if (!normalizedByPath.has('SKILL.md')) {
    validationErrors.push('Skill bundle must include SKILL.md at the bundle root.');
  }

  const sortedFiles = [...normalizedByPath.values()].sort(compareSkillFiles);
  const skillFile = normalizedByPath.get('SKILL.md');
  const frontmatter = parseSkillFrontmatter(skillFile?.content ?? '');
  if (!frontmatter.ok) {
    validationErrors.push(frontmatter.error);
  }
  const parsed = frontmatter.ok ? frontmatter.frontmatter : {};
  if (!parsed.name) {
    validationErrors.push('SKILL.md frontmatter must define a non-empty name.');
  }
  if (!parsed.description) {
    validationErrors.push('SKILL.md frontmatter must define a non-empty description.');
  }

  return {
    name: parsed.name?.trim() || 'Untitled skill',
    description: parsed.description?.trim() || '',
    files: sortedFiles,
    validationStatus: validationErrors.length > 0 ? 'invalid' : 'valid',
    validationErrors,
    bundleStats: {
      fileCount: sortedFiles.length,
      totalBytes
    }
  };
}

export function getTargetSkillBundleStorageLimitErrors(bundle: Pick<NormalizedTargetSkillBundle, 'files' | 'bundleStats'>): string[] {
  const errors: string[] = [];
  if (bundle.bundleStats.fileCount < 1) {
    errors.push('Skill bundle must include at least one Markdown file.');
  }
  if (bundle.bundleStats.fileCount > TARGET_SKILL_MAX_FILES) {
    errors.push(`Skill bundle can include at most ${TARGET_SKILL_MAX_FILES} Markdown files.`);
  }
  if (bundle.bundleStats.totalBytes > TARGET_SKILL_MAX_TOTAL_BYTES) {
    errors.push(`Skill bundle exceeds the ${TARGET_SKILL_MAX_TOTAL_BYTES} byte limit.`);
  }
  for (const file of bundle.files) {
    if (file.sizeBytes > TARGET_SKILL_MAX_FILE_BYTES) {
      errors.push(`Skill file "${file.path}" exceeds the ${TARGET_SKILL_MAX_FILE_BYTES} byte limit.`);
    }
  }
  return errors;
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

function compareSkillFiles(left: TargetSkillFile, right: TargetSkillFile): number {
  if (left.path === 'SKILL.md' && right.path !== 'SKILL.md') return -1;
  if (left.path !== 'SKILL.md' && right.path === 'SKILL.md') return 1;
  return left.path.localeCompare(right.path);
}

function normalizeBundlePath(rawPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const candidate = String(rawPath || '').replaceAll('\\', '/').trim();
  if (!candidate) {
    return { ok: false, error: 'Skill file path must not be empty.' };
  }
  if (candidate.startsWith('/') || candidate.endsWith('/')) {
    return { ok: false, error: `Skill file path "${candidate}" must be a relative file path.` };
  }
  if (candidate.includes('//')) {
    return { ok: false, error: `Skill file path "${candidate}" must not contain empty path segments.` };
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    return { ok: false, error: `Skill file path "${candidate}" contains an invalid path segment.` };
  }
  if (candidate === 'SKILL.md') {
    return { ok: true, path: candidate };
  }
  if (!candidate.endsWith('.md')) {
    return { ok: false, error: `Skill file "${candidate}" must be Markdown.` };
  }
  return { ok: true, path: candidate };
}

function parseSkillFrontmatter(content: string): { ok: true; frontmatter: ParsedFrontmatter } | { ok: false; error: string } {
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { ok: false, error: 'SKILL.md must start with YAML frontmatter delimited by ---.' };
  }
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { ok: false, error: 'SKILL.md frontmatter must end with a closing --- line.' };
  }
  const rawFrontmatter = normalized.slice(4, endIndex);
  const frontmatter: ParsedFrontmatter = {};
  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      return { ok: false, error: `Unsupported SKILL.md frontmatter line "${trimmed}".` };
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = unquoteFrontmatterValue(rawValue);
    if (key === 'name' || key === 'description') {
      frontmatter[key] = value;
    }
  }
  return { ok: true, frontmatter };
}

function unquoteFrontmatterValue(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}
