import { z } from 'zod';

const targetSkillFileSchema = z.object({
  path: z.string().trim().min(1).max(512),
  content: z.string().max(32768)
}).strict();

function isValidImportRepoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    return parsed.protocol === 'https:' && segments.length >= 2;
  } catch {
    return false;
  }
}

function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidGitSubpath(value: string): boolean {
  const segments = value.replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '').split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

const targetSkillGitImportSourceSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  repoUrl: z.string().url().refine(isValidImportRepoUrl, 'repoUrl must be an HTTPS Git repository URL'),
  apiBaseUrl: z.string().url().refine(isValidHttpsUrl, 'apiBaseUrl must be an HTTPS URL').optional(),
  ref: z.string().trim().min(1).max(255),
  subpath: z.string().trim().min(1).max(512).refine(isValidGitSubpath, 'subpath contains an invalid path segment').optional(),
  commitSha: z.string().trim().regex(/^[0-9a-f]{40}$/i, 'commitSha must be a full Git commit SHA').optional()
}).strict().superRefine((value, ctx) => {
  if (!value.apiBaseUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(value.apiBaseUrl);
  } catch {
    return;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
  const expectedSuffix = value.provider === 'github' ? '/api/v3' : '/api/v4';
  if (!normalizedPath.endsWith(expectedSuffix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiBaseUrl'],
      message: `apiBaseUrl must end with ${expectedSuffix} for ${value.provider}`
    });
  }
});

export const createTargetSkillSchema = z.object({
  files: z.array(targetSkillFileSchema).min(1).max(16)
}).strict();

export const importTargetSkillSchema = z.object({
  files: z.array(targetSkillFileSchema).min(1).max(16),
  source: targetSkillGitImportSourceSchema
}).strict();

export const updateTargetSkillSchema = z.object({
  enabled: z.boolean().optional(),
  files: z.array(targetSkillFileSchema).min(1).max(16).optional()
}).strict().refine((input) => input.enabled !== undefined || input.files !== undefined, {
  message: 'at least one field is required'
});

export const reimportTargetSkillSchema = z.object({
  force: z.boolean().optional().default(false),
  files: z.array(targetSkillFileSchema).min(1).max(16),
  source: targetSkillGitImportSourceSchema
}).strict();
