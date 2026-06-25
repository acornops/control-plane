import { gunzipSync } from 'node:zlib';
import { config } from '../config.js';
import { TargetSkillSource } from '../types/domain.js';
import { TargetSkillBundleFileInput } from './target-skills.js';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_CODELOAD_BASE_URL = 'https://codeload.github.com';

interface GithubApiTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface GithubApiErrorPayload {
  message?: string;
}

interface TarArchiveFile {
  path: string;
  content: string;
}

interface ParsedGithubRepo {
  owner: string;
  repo: string;
  repoUrl: string;
  embeddedRef?: string;
  embeddedSubpath?: string;
}

export interface ImportTargetSkillFromGithubInput {
  repoUrl: string;
  ref?: string;
  subpath?: string;
}

export interface ImportedGithubTargetSkill {
  files: TargetSkillBundleFileInput[];
  source: TargetSkillSource;
}

export class GithubSkillImportError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code:
      | 'INVALID_REPO_URL'
      | 'UNSUPPORTED_REPO_HOST'
      | 'REPOSITORY_NOT_FOUND'
      | 'REF_NOT_FOUND'
      | 'SUBPATH_NOT_FOUND'
      | 'INVALID_SKILL_BUNDLE'
      | 'UPSTREAM_ERROR'
  ) {
    super(message);
  }
}

export async function importTargetSkillFromGithub(input: ImportTargetSkillFromGithubInput): Promise<ImportedGithubTargetSkill> {
  const parsedRepo = parseGithubRepoUrl(input.repoUrl);
  const normalizedInput = normalizeGithubImportInput(input, parsedRepo);
  try {
    return await importTargetSkillFromGithubApi(normalizedInput, parsedRepo);
  } catch (err) {
    if (err instanceof GithubSkillImportError && isRateLimitError(err)) {
      return importTargetSkillFromGithubArchive(normalizedInput, parsedRepo);
    }
    throw err;
  }
}

async function importTargetSkillFromGithubApi(
  input: ImportTargetSkillFromGithubInput,
  parsedRepo: ParsedGithubRepo
): Promise<ImportedGithubTargetSkill> {
  const repoInfo = await githubGet<{ default_branch?: string }>(`/repos/${parsedRepo.owner}/${parsedRepo.repo}`);
  const effectiveRef = String(input.ref || repoInfo.default_branch || '').trim();
  if (!effectiveRef) {
    throw new GithubSkillImportError('Unable to determine a Git ref for the requested repository.', 502, 'UPSTREAM_ERROR');
  }

  const commit = await githubGet<{ sha?: string }>(
    `/repos/${parsedRepo.owner}/${parsedRepo.repo}/commits/${encodeURIComponent(effectiveRef)}`,
    { refErrorCode: 'REF_NOT_FOUND' }
  );
  const commitSha = String(commit.sha || '').trim();
  if (!commitSha) {
    throw new GithubSkillImportError('GitHub did not return a commit SHA for the requested ref.', 502, 'UPSTREAM_ERROR');
  }

  const normalizedSubpath = normalizeImportSubpath(input.subpath);
  const tree = await githubGet<{ tree?: GithubApiTreeEntry[] }>(
    `/repos/${parsedRepo.owner}/${parsedRepo.repo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`
  );
  const allEntries = Array.isArray(tree.tree) ? tree.tree : [];
  const bundleEntries = allEntries.filter((entry) => isEntryWithinSubpath(entry.path, normalizedSubpath));
  const fileEntries = bundleEntries.filter((entry) => entry.type === 'blob');
  if (fileEntries.length === 0) {
    throw new GithubSkillImportError('The requested Git subpath does not exist or does not contain files.', 404, 'SUBPATH_NOT_FOUND');
  }

  const invalidEntries = bundleEntries.filter((entry) => entry.type !== 'tree' && entry.type !== 'blob');
  const skillFileEntries = fileEntries.filter((entry) => isAllowedSkillEntry(entry.path, normalizedSubpath));
  if (invalidEntries.length > 0) {
    throw new GithubSkillImportError(
      `Git import only supports regular repository files. Unsupported entry: ${invalidEntries[0].path}`,
      400,
      'INVALID_SKILL_BUNDLE'
    );
  }
  if (skillFileEntries.length === 0) {
    throw new GithubSkillImportError('The requested Git subpath does not contain SKILL.md or Markdown skill files.', 400, 'INVALID_SKILL_BUNDLE');
  }
  if (!skillFileEntries.some((entry) => toBundleRelativePath(entry.path, normalizedSubpath) === 'SKILL.md')) {
    throw new GithubSkillImportError(
      'Git import requires SKILL.md at the selected repository path. Provide subpath to a specific skill folder.',
      400,
      'INVALID_SKILL_BUNDLE'
    );
  }

  const files: TargetSkillBundleFileInput[] = [];
  for (const entry of skillFileEntries.sort((left, right) => left.path.localeCompare(right.path))) {
    const blob = await githubGet<{ content?: string; encoding?: string }>(
      `/repos/${parsedRepo.owner}/${parsedRepo.repo}/git/blobs/${encodeURIComponent(entry.sha)}`
    );
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GithubSkillImportError(`GitHub returned unsupported content encoding for ${entry.path}.`, 502, 'UPSTREAM_ERROR');
    }
    files.push({
      path: toBundleRelativePath(entry.path, normalizedSubpath),
      content: Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8')
    });
  }

  return {
    files,
    source: {
      type: 'git_import',
      repoUrl: parsedRepo.repoUrl,
      ref: effectiveRef,
      subpath: normalizedSubpath || undefined,
      commitSha,
      syncStatus: 'current'
    }
  };
}

async function importTargetSkillFromGithubArchive(
  input: ImportTargetSkillFromGithubInput,
  parsedRepo: ParsedGithubRepo
): Promise<ImportedGithubTargetSkill> {
  const normalizedSubpath = normalizeImportSubpath(input.subpath);
  const candidateRefs = archiveFallbackRefs(input.ref);
  let lastError: GithubSkillImportError | undefined;

  for (const ref of candidateRefs) {
    try {
      const archiveFiles = await downloadGithubTarball(parsedRepo, ref);
      const files = filesFromArchive(archiveFiles, normalizedSubpath);
      if (files.length === 0) {
        throw new GithubSkillImportError('The requested Git subpath does not contain SKILL.md or Markdown skill files.', 400, 'INVALID_SKILL_BUNDLE');
      }
      if (!files.some((file) => file.path === 'SKILL.md')) {
        throw new GithubSkillImportError(
          'Git import requires SKILL.md at the selected repository path. Provide subpath to a specific skill folder.',
          400,
          'INVALID_SKILL_BUNDLE'
        );
      }
      return {
        files,
        source: {
          type: 'git_import',
          repoUrl: parsedRepo.repoUrl,
          ref,
          subpath: normalizedSubpath || undefined,
          commitSha: isFullCommitSha(ref) ? ref : undefined,
          syncStatus: 'current'
        }
      };
    } catch (err) {
      if (!(err instanceof GithubSkillImportError)) {
        throw err;
      }
      lastError = err;
      if (input.ref || err.code !== 'REF_NOT_FOUND') {
        throw err;
      }
    }
  }

  throw lastError || new GithubSkillImportError(
    'GitHub API rate limit was exceeded and the archive fallback could not determine a default branch. Provide a ref such as main, master, a tag, or a commit SHA.',
    403,
    'UPSTREAM_ERROR'
  );
}

function parseGithubRepoUrl(rawUrl: string): ParsedGithubRepo {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GithubSkillImportError('Skill import only supports valid GitHub HTTPS repository URLs.', 400, 'INVALID_REPO_URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new GithubSkillImportError('Skill import only supports GitHub HTTPS repository URLs.', 400, 'INVALID_REPO_URL');
  }
  if (parsed.hostname !== 'github.com') {
    throw new GithubSkillImportError('Skill import only supports unauthenticated GitHub repositories.', 400, 'UNSUPPORTED_REPO_HOST');
  }
  const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new GithubSkillImportError('Repository URL contains an invalid encoded path segment.', 400, 'INVALID_REPO_URL');
    }
  });
  if (segments.length < 2) {
    throw new GithubSkillImportError('Repository URL must point to github.com/{owner}/{repo}.', 400, 'INVALID_REPO_URL');
  }
  if (segments.length > 2 && segments[2] !== 'tree') {
    throw new GithubSkillImportError(
      'Repository URL must point to github.com/{owner}/{repo} or a GitHub tree URL for a skill folder.',
      400,
      'INVALID_REPO_URL'
    );
  }
  const treePath = segments[2] === 'tree' ? segments.slice(3) : [];
  if (segments[2] === 'tree' && treePath.length === 0) {
    throw new GithubSkillImportError('GitHub tree URL must include a ref such as main.', 400, 'INVALID_REPO_URL');
  }
  return {
    owner: segments[0],
    repo: segments[1],
    repoUrl: `https://github.com/${segments[0]}/${segments[1]}`,
    embeddedRef: treePath[0],
    embeddedSubpath: treePath.slice(1).join('/') || undefined
  };
}

function normalizeGithubImportInput(
  input: ImportTargetSkillFromGithubInput,
  parsedRepo: ParsedGithubRepo
): ImportTargetSkillFromGithubInput {
  const explicitRef = optionalTrimmedString(input.ref);
  const explicitSubpath = optionalTrimmedString(input.subpath);
  if (explicitRef && parsedRepo.embeddedRef && explicitRef !== parsedRepo.embeddedRef) {
    throw new GithubSkillImportError(
      'GitHub tree URL already includes a ref. Leave the Ref field empty or use a bare repository URL.',
      400,
      'INVALID_REPO_URL'
    );
  }
  if (explicitSubpath && parsedRepo.embeddedSubpath && normalizeImportSubpath(explicitSubpath) !== parsedRepo.embeddedSubpath) {
    throw new GithubSkillImportError(
      'GitHub tree URL already includes a subpath. Leave the Subpath field empty or use a bare repository URL.',
      400,
      'INVALID_REPO_URL'
    );
  }
  return {
    repoUrl: parsedRepo.repoUrl,
    ref: explicitRef || parsedRepo.embeddedRef,
    subpath: explicitSubpath || parsedRepo.embeddedSubpath
  };
}

function optionalTrimmedString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function normalizeImportSubpath(rawSubpath: string | undefined): string {
  const candidate = String(rawSubpath || '').replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '');
  if (!candidate) {
    return '';
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    throw new GithubSkillImportError('Git subpath contains an invalid path segment.', 400, 'INVALID_SKILL_BUNDLE');
  }
  return candidate;
}

function isRateLimitError(err: GithubSkillImportError): boolean {
  return err.statusCode === 403 || err.statusCode === 429;
}

function archiveFallbackRefs(rawRef: string | undefined): string[] {
  const requestedRef = String(rawRef || '').trim();
  if (requestedRef) {
    return [requestedRef];
  }
  return ['main', 'master'];
}

function isFullCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

async function downloadGithubTarball(parsedRepo: ParsedGithubRepo, ref: string): Promise<TarArchiveFile[]> {
  const response = await fetch(
    `${GITHUB_CODELOAD_BASE_URL}/${parsedRepo.owner}/${parsedRepo.repo}/tar.gz/${encodeURIComponent(ref)}`,
    {
      headers: {
        'User-Agent': 'acornops-control-plane'
      }
    }
  );
  if (response.status === 404) {
    throw new GithubSkillImportError('The requested Git ref was not found.', 404, 'REF_NOT_FOUND');
  }
  if (!response.ok) {
    throw new GithubSkillImportError('GitHub archive import request failed.', response.status, 'UPSTREAM_ERROR');
  }
  const archive = Buffer.from(await response.arrayBuffer());
  return parseTarArchive(gunzipSync(archive));
}

function filesFromArchive(archiveFiles: TarArchiveFile[], subpath: string): TargetSkillBundleFileInput[] {
  const files: TargetSkillBundleFileInput[] = [];
  for (const file of archiveFiles) {
    const entryPath = stripArchiveRoot(file.path);
    if (!isEntryWithinSubpath(entryPath, subpath) || !isAllowedSkillEntry(entryPath, subpath)) {
      continue;
    }
    files.push({
      path: toBundleRelativePath(entryPath, subpath),
      content: file.content
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function stripArchiveRoot(path: string): string {
  const separatorIndex = path.indexOf('/');
  if (separatorIndex === -1) {
    return '';
  }
  return path.slice(separatorIndex + 1);
}

function parseTarArchive(buffer: Buffer): TarArchiveFile[] {
  const files: TarArchiveFile[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }
    const path = readTarPath(header);
    const size = readTarSize(header);
    const typeFlag = header.toString('utf8', 156, 157);
    const contentOffset = offset + 512;
    const nextOffset = contentOffset + Math.ceil(size / 512) * 512;
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      files.push({
        path,
        content: buffer.subarray(contentOffset, contentOffset + size).toString('utf8')
      });
    }
    offset = nextOffset;
  }
  return files;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function readTarPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarSize(header: Buffer): number {
  const rawSize = readTarString(header, 124, 12).trim();
  if (!rawSize) {
    return 0;
  }
  return Number.parseInt(rawSize, 8);
}

function readTarString(header: Buffer, start: number, length: number): string {
  const rawValue = header.subarray(start, start + length);
  const nullIndex = rawValue.indexOf(0);
  return rawValue.subarray(0, nullIndex === -1 ? rawValue.length : nullIndex).toString('utf8');
}

function isEntryWithinSubpath(entryPath: string, subpath: string): boolean {
  if (!subpath) {
    return true;
  }
  return entryPath === subpath || entryPath.startsWith(`${subpath}/`);
}

function isAllowedSkillEntry(entryPath: string, subpath: string): boolean {
  const relativePath = toBundleRelativePath(entryPath, subpath);
  return relativePath === 'SKILL.md' || relativePath.endsWith('.md');
}

function toBundleRelativePath(entryPath: string, subpath: string): string {
  if (!subpath) {
    return entryPath;
  }
  return entryPath.slice(subpath.length + 1);
}

async function githubGet<T>(
  path: string,
  options: {
    refErrorCode?: 'REF_NOT_FOUND';
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'acornops-control-plane'
  };
  if (config.GITHUB_IMPORT_TOKEN) {
    headers.Authorization = `Bearer ${config.GITHUB_IMPORT_TOKEN}`;
  }
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers
  });

  if (!response.ok) {
    let payload: GithubApiErrorPayload | undefined;
    try {
      payload = await response.json() as GithubApiErrorPayload;
    } catch {
      payload = undefined;
    }
    if (response.status === 404 && options.refErrorCode === 'REF_NOT_FOUND') {
      throw new GithubSkillImportError('The requested Git ref was not found.', 404, 'REF_NOT_FOUND');
    }
    if (response.status === 404) {
      throw new GithubSkillImportError(
        'The repository was not found or is not publicly accessible.',
        404,
        'REPOSITORY_NOT_FOUND'
      );
    }
    throw new GithubSkillImportError(payload?.message || 'GitHub import request failed.', response.status, 'UPSTREAM_ERROR');
  }

  return response.json() as Promise<T>;
}
