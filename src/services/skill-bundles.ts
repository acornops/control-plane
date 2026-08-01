export const SKILL_BUNDLE_MAX_FILES = 16;
export const SKILL_BUNDLE_MAX_TOTAL_BYTES = 128 * 1024;
export const SKILL_BUNDLE_MAX_FILE_BYTES = 32 * 1024;

export interface SkillBundleFileInput {
  path: string;
  content: string;
}

export interface SkillBundleFile extends SkillBundleFileInput {
  sizeBytes: number;
}

export interface NormalizedSkillBundle {
  name: string;
  description: string;
  files: SkillBundleFile[];
  validationStatus: 'valid' | 'invalid';
  validationErrors: string[];
  bundleStats: { fileCount: number; totalBytes: number };
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
}

export function normalizeSkillBundle(files: SkillBundleFileInput[]): NormalizedSkillBundle {
  const validationErrors: string[] = [];
  const normalizedByPath = new Map<string, SkillBundleFile>();
  let totalBytes = 0;

  if (!Array.isArray(files) || files.length === 0) {
    validationErrors.push('Skill bundle must include at least one Markdown file.');
  }
  if (files.length > SKILL_BUNDLE_MAX_FILES) {
    validationErrors.push(`Skill bundle can include at most ${SKILL_BUNDLE_MAX_FILES} Markdown files.`);
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
    if (sizeBytes > SKILL_BUNDLE_MAX_FILE_BYTES) {
      validationErrors.push(`Skill file "${normalizedPath.path}" exceeds the ${SKILL_BUNDLE_MAX_FILE_BYTES} byte limit.`);
    }
    totalBytes += sizeBytes;
    normalizedByPath.set(normalizedPath.path, { path: normalizedPath.path, content, sizeBytes });
  }
  if (totalBytes > SKILL_BUNDLE_MAX_TOTAL_BYTES) {
    validationErrors.push(`Skill bundle exceeds the ${SKILL_BUNDLE_MAX_TOTAL_BYTES} byte limit.`);
  }
  if (!normalizedByPath.has('SKILL.md')) {
    validationErrors.push('Skill bundle must include SKILL.md at the bundle root.');
  }
  const sortedFiles = [...normalizedByPath.values()].sort(compareSkillFiles);
  const frontmatter = parseSkillFrontmatter(normalizedByPath.get('SKILL.md')?.content ?? '');
  if (!frontmatter.ok) validationErrors.push(frontmatter.error);
  const parsed = frontmatter.ok ? frontmatter.frontmatter : {};
  if (!parsed.name) validationErrors.push('SKILL.md frontmatter must define a non-empty name.');
  if (!parsed.description) validationErrors.push('SKILL.md frontmatter must define a non-empty description.');
  return {
    name: parsed.name?.trim() || 'Untitled skill',
    description: parsed.description?.trim() || '',
    files: sortedFiles,
    validationStatus: validationErrors.length > 0 ? 'invalid' : 'valid',
    validationErrors,
    bundleStats: { fileCount: sortedFiles.length, totalBytes }
  };
}

export function getSkillBundleStorageLimitErrors(
  bundle: Pick<NormalizedSkillBundle, 'files' | 'bundleStats'>
): string[] {
  const errors: string[] = [];
  if (bundle.bundleStats.fileCount < 1) errors.push('Skill bundle must include at least one Markdown file.');
  if (bundle.bundleStats.fileCount > SKILL_BUNDLE_MAX_FILES) {
    errors.push(`Skill bundle can include at most ${SKILL_BUNDLE_MAX_FILES} Markdown files.`);
  }
  if (bundle.bundleStats.totalBytes > SKILL_BUNDLE_MAX_TOTAL_BYTES) {
    errors.push(`Skill bundle exceeds the ${SKILL_BUNDLE_MAX_TOTAL_BYTES} byte limit.`);
  }
  for (const file of bundle.files) {
    if (file.sizeBytes > SKILL_BUNDLE_MAX_FILE_BYTES) {
      errors.push(`Skill file "${file.path}" exceeds the ${SKILL_BUNDLE_MAX_FILE_BYTES} byte limit.`);
    }
  }
  return errors;
}

function compareSkillFiles(left: SkillBundleFile, right: SkillBundleFile): number {
  if (left.path === 'SKILL.md' && right.path !== 'SKILL.md') return -1;
  if (left.path !== 'SKILL.md' && right.path === 'SKILL.md') return 1;
  return left.path.localeCompare(right.path);
}

function normalizeBundlePath(rawPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const candidate = String(rawPath || '').replaceAll('\\', '/').trim();
  if (!candidate) return { ok: false, error: 'Skill file path must not be empty.' };
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
  if (candidate === 'SKILL.md') return { ok: true, path: candidate };
  if (!candidate.endsWith('.md')) {
    return { ok: false, error: `Skill file "${candidate}" must be Markdown.` };
  }
  return { ok: true, path: candidate };
}

function parseSkillFrontmatter(content: string):
  | { ok: true; frontmatter: ParsedFrontmatter }
  | { ok: false; error: string } {
  const normalized = String(content || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { ok: false, error: 'SKILL.md must start with YAML frontmatter delimited by ---.' };
  }
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { ok: false, error: 'SKILL.md frontmatter must end with a closing --- line.' };
  }
  const frontmatter: ParsedFrontmatter = {};
  for (const line of normalized.slice(4, endIndex).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      return { ok: false, error: `Unsupported SKILL.md frontmatter line "${trimmed}".` };
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key === 'name' || key === 'description') {
      frontmatter[key] = unquoteFrontmatterValue(trimmed.slice(separatorIndex + 1).trim());
    }
  }
  return { ok: true, frontmatter };
}

function unquoteFrontmatterValue(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  )) return value.slice(1, -1).trim();
  return value.trim();
}
