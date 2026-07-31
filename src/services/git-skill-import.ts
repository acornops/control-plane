import { config } from '../config.js';
import {
  GitImportHost,
  matchGitImportHost
} from '../config-git-imports.js';
import {
  GitSkillImportError,
  type GitSkillResolveInput,
  type ResolvedGitSkill
} from './git-skill-import-contracts.js';
import {
  decodeBase64Utf8,
  gitJson,
  gitLabPages,
  gitText
} from './git-skill-import-http.js';
import {
  normalizeSubpath,
  parseGitHubRepository,
  parseGitLabRepository,
  resolveLocation,
  type ParsedRepository
} from './git-skill-import-location.js';

export { GitSkillImportError } from './git-skill-import-contracts.js';
export type {
  GitSkillImportErrorCode,
  GitSkillResolveInput,
  ResolvedGitSkill
} from './git-skill-import-contracts.js';

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

interface GitLabTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  id: string;
}

const MAX_FILES = 16;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_GITHUB_SUBPATH_SEGMENTS = 16;
const MAX_SMALL_JSON_BYTES = 64 * 1024;
const MAX_BLOB_JSON_BYTES = 64 * 1024;
const MAX_GITHUB_TREE_JSON_BYTES = 8 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 30_000;

export async function resolveGitSkill(
  input: GitSkillResolveInput,
  fetchImpl: typeof fetch = globalThis.fetch,
  hosts: readonly GitImportHost[] = config.GIT_IMPORT_HOSTS
): Promise<ResolvedGitSkill> {
  validateImportUrl(input.repoUrl);
  const host = matchGitImportHost(input.repoUrl, hosts);
  if (!host) {
    throw new GitSkillImportError(
      'This Git host is not supported by this AcornOps deployment.',
      'UNSUPPORTED_GIT_HOST',
      400
    );
  }
  const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  return host.provider === 'gitlab'
    ? resolveGitLabSkill(input, host, fetchImpl, signal)
    : resolveGitHubSkill(input, host, fetchImpl, signal);
}

function validateImportUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl);
    if (rawUrl.length > 2048
      || url.protocol !== 'https:'
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash) {
      throw new Error('invalid');
    }
  } catch {
    throw new GitSkillImportError(
      'Git import requires a full HTTPS repository, folder, or SKILL.md URL without credentials, query parameters, or fragments.',
      'INVALID_REPO_URL',
      400
    );
  }
}

async function resolveGitHubSkill(
  input: GitSkillResolveInput,
  host: GitImportHost,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<ResolvedGitSkill> {
  const parsed = parseGitHubRepository(input.repoUrl, host);
  const repository = await gitJson<{ default_branch?: string }>(
    `${host.apiBaseUrl}/repos/${encodeURIComponent(parsed.owner!)}/${encodeURIComponent(parsed.repo!)}`,
    fetchImpl,
    signal,
    MAX_SMALL_JSON_BYTES
  );
  const location = await resolveLocation(
    input,
    parsed,
    String(repository.default_branch || ''),
    async (ref) => {
      const commit = await gitJson<{ sha?: string }>(
        `${host.apiBaseUrl}/repos/${encodeURIComponent(parsed.owner!)}/${encodeURIComponent(parsed.repo!)}/commits/${encodeURIComponent(ref)}`,
        fetchImpl,
        signal,
        MAX_SMALL_JSON_BYTES
      );
      return validatedCommitSha(commit.sha, 'GitHub');
    }
  );
  const { ref, commitSha } = location;
  const subpath = normalizeSubpath(location.subpath);
  const treeSha = await resolveGitHubTreeSha(
    host,
    parsed,
    commitSha,
    subpath,
    fetchImpl,
    signal
  );
  const tree = await gitJson<{ tree?: GitHubTreeEntry[]; truncated?: boolean }>(
    `${host.apiBaseUrl}/repos/${encodeURIComponent(parsed.owner!)}/${encodeURIComponent(parsed.repo!)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    fetchImpl,
    signal,
    MAX_GITHUB_TREE_JSON_BYTES
  );
  if (tree.truncated) {
    throw new GitSkillImportError(
      'GitHub returned a truncated repository tree. Import a smaller skill folder.',
      'INVALID_GIT_SUBPATH',
      400
    );
  }
  const allEntries = (Array.isArray(tree.tree) ? tree.tree : []).map((entry) => ({
    ...entry,
    path: subpath ? `${subpath}/${entry.path}` : entry.path
  }));
  const bundleEntries = allEntries.filter((entry) => isWithinSubpath(entry.path, subpath));
  const unsupported = bundleEntries.find((entry) => entry.type !== 'tree' && entry.type !== 'blob');
  if (unsupported) {
    throw new GitSkillImportError(
      `Git import only supports regular repository files. Unsupported entry: ${unsupported.path}`,
      'INVALID_SKILL_BUNDLE',
      400
    );
  }
  const entries = validateSkillEntries(
    bundleEntries.filter((entry) => entry.type === 'blob'),
    subpath
  );
  const files: ResolvedGitSkill['files'] = [];
  let totalBytes = 0;
  for (const entry of sortSkillEntries(entries, subpath)) {
    const blob = await gitJson<{ content?: string; encoding?: string }>(
      `${host.apiBaseUrl}/repos/${encodeURIComponent(parsed.owner!)}/${encodeURIComponent(parsed.repo!)}/git/blobs/${encodeURIComponent(entry.sha)}`,
      fetchImpl,
      signal,
      MAX_BLOB_JSON_BYTES
    );
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitSkillImportError(
        `GitHub returned unsupported content encoding for ${entry.path}.`,
        'INVALID_SKILL_BUNDLE',
        400
      );
    }
    totalBytes = appendFile(files, {
      path: relativePath(entry.path, subpath),
      content: decodeBase64Utf8(blob.content)
    }, totalBytes);
  }
  return resolvedSkill(parsed, ref, subpath, commitSha, files);
}

async function resolveGitHubTreeSha(
  host: GitImportHost,
  parsed: ParsedRepository,
  commitSha: string,
  subpath: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<string> {
  if (!subpath) return commitSha;
  const segments = subpath.split('/');
  if (segments.length > MAX_GITHUB_SUBPATH_SEGMENTS) {
    throw new GitSkillImportError(
      `GitHub skill folders can be at most ${MAX_GITHUB_SUBPATH_SEGMENTS} path segments deep.`,
      'INVALID_GIT_SUBPATH',
      400
    );
  }

  let treeSha = commitSha;
  for (const segment of segments) {
    const tree = await gitJson<{ tree?: GitHubTreeEntry[] }>(
      `${host.apiBaseUrl}/repos/${encodeURIComponent(parsed.owner!)}/${encodeURIComponent(parsed.repo!)}/git/trees/${encodeURIComponent(treeSha)}`,
      fetchImpl,
      signal,
      MAX_GITHUB_TREE_JSON_BYTES
    );
    const entry = Array.isArray(tree.tree)
      ? tree.tree.find((candidate) => candidate.type === 'tree' && candidate.path === segment)
      : undefined;
    if (!entry?.sha) {
      throw new GitSkillImportError(
        'The requested GitHub skill folder was not found at the resolved commit.',
        'INVALID_GIT_SUBPATH',
        400
      );
    }
    treeSha = entry.sha;
  }
  return treeSha;
}

async function resolveGitLabSkill(
  input: GitSkillResolveInput,
  host: GitImportHost,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<ResolvedGitSkill> {
  const parsed = parseGitLabRepository(input.repoUrl, host);
  const projectId = encodeURIComponent(parsed.projectPath!);
  const project = await gitJson<{ default_branch?: string }>(
    `${host.apiBaseUrl}/projects/${projectId}`,
    fetchImpl,
    signal,
    MAX_SMALL_JSON_BYTES
  );
  const location = await resolveLocation(
    input,
    parsed,
    String(project.default_branch || ''),
    async (ref) => {
      const commit = await gitJson<{ id?: string }>(
        `${host.apiBaseUrl}/projects/${projectId}/repository/commits/${encodeURIComponent(ref)}`,
        fetchImpl,
        signal,
        MAX_SMALL_JSON_BYTES
      );
      return validatedCommitSha(commit.id, 'GitLab');
    }
  );
  const { ref, commitSha } = location;
  const subpath = normalizeSubpath(location.subpath);
  const treeUrl = new URL(`${host.apiBaseUrl}/projects/${projectId}/repository/tree`);
  treeUrl.searchParams.set('ref', commitSha);
  treeUrl.searchParams.set('recursive', 'true');
  treeUrl.searchParams.set('per_page', '100');
  if (subpath) treeUrl.searchParams.set('path', subpath);
  const allEntries = (await gitLabPages<GitLabTreeEntry>(treeUrl, fetchImpl, signal))
    .map((entry) => ({ ...entry, path: normalizeGitLabPath(entry.path, subpath) }));
  const entries = validateSkillEntries(
    allEntries.filter((entry) => entry.type === 'blob' && isWithinSubpath(entry.path, subpath)),
    subpath
  );
  const files: ResolvedGitSkill['files'] = [];
  let totalBytes = 0;
  for (const entry of sortSkillEntries(entries, subpath)) {
    const content = await gitText(
      `${host.apiBaseUrl}/projects/${projectId}/repository/blobs/${encodeURIComponent(entry.id)}/raw`,
      fetchImpl,
      signal,
      MAX_FILE_BYTES
    );
    totalBytes = appendFile(files, {
      path: relativePath(entry.path, subpath),
      content
    }, totalBytes);
  }
  return resolvedSkill(parsed, ref, subpath, commitSha, files);
}

function validatedCommitSha(value: string | undefined, provider: string): string {
  const commitSha = String(value || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new GitSkillImportError(
      `${provider} returned an invalid commit SHA.`,
      'GIT_PROVIDER_FAILED',
      502
    );
  }
  return commitSha;
}

function validateSkillEntries<T extends { path: string }>(entries: T[], subpath: string): T[] {
  if (entries.length === 0) {
    throw new GitSkillImportError(
      'The requested Git path does not exist or does not contain files.',
      'INVALID_GIT_SUBPATH',
      400
    );
  }
  const markdown = entries.filter((entry) => {
    const path = relativePath(entry.path, subpath);
    return path === 'SKILL.md' || path.endsWith('.md');
  });
  const seenPaths = new Set<string>();
  for (const entry of markdown) {
    const path = relativePath(entry.path, subpath);
    const segments = path.replaceAll('\\', '/').split('/');
    if (!path
      || path.length > 512
      || path.startsWith('/')
      || path.endsWith('/')
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || seenPaths.has(path)) {
      throw new GitSkillImportError(
        `Git import contains an invalid or duplicate Markdown path: ${path || '(empty)'}`,
        'INVALID_SKILL_BUNDLE',
        400
      );
    }
    seenPaths.add(path);
  }
  if (!markdown.some((entry) => relativePath(entry.path, subpath) === 'SKILL.md')) {
    throw new GitSkillImportError(
      'Git import requires SKILL.md at the selected repository path.',
      'INVALID_SKILL_BUNDLE',
      400
    );
  }
  if (markdown.length > MAX_FILES) {
    throw new GitSkillImportError(
      `Git import can include at most ${MAX_FILES} Markdown files.`,
      'INVALID_SKILL_BUNDLE',
      400
    );
  }
  return markdown;
}

function resolvedSkill(
  parsed: ParsedRepository,
  ref: string,
  subpath: string,
  commitSha: string,
  files: ResolvedGitSkill['files']
): ResolvedGitSkill {
  return {
    files,
    source: {
      provider: parsed.provider,
      repoUrl: parsed.repoUrl,
      ref,
      ...(subpath ? { subpath } : {}),
      commitSha
    }
  };
}

function isWithinSubpath(path: string, subpath: string): boolean {
  return !subpath || path === subpath || path.startsWith(`${subpath}/`);
}

function relativePath(path: string, subpath: string): string {
  return subpath ? path.slice(subpath.length + 1) : path;
}

function normalizeGitLabPath(path: string, subpath: string): string {
  return !subpath || isWithinSubpath(path, subpath)
    ? path
    : `${subpath}/${String(path).replace(/^\/+/, '')}`;
}

function sortSkillEntries<T extends { path: string }>(entries: T[], subpath: string): T[] {
  return [...entries].sort((left, right) => {
    const leftPath = relativePath(left.path, subpath);
    const rightPath = relativePath(right.path, subpath);
    if (leftPath === 'SKILL.md' && rightPath !== 'SKILL.md') return -1;
    if (leftPath !== 'SKILL.md' && rightPath === 'SKILL.md') return 1;
    return leftPath.localeCompare(rightPath);
  });
}

function appendFile(
  files: ResolvedGitSkill['files'],
  file: ResolvedGitSkill['files'][number],
  currentTotal: number
): number {
  const size = Buffer.byteLength(file.content, 'utf8');
  if (size > MAX_FILE_BYTES) {
    throw new GitSkillImportError(
      `Git import file "${file.path}" exceeds ${MAX_FILE_BYTES} bytes.`,
      'INVALID_SKILL_BUNDLE',
      400
    );
  }
  if (currentTotal + size > MAX_TOTAL_BYTES) {
    throw new GitSkillImportError(
      `Git import exceeds ${MAX_TOTAL_BYTES} bytes.`,
      'INVALID_SKILL_BUNDLE',
      400
    );
  }
  files.push(file);
  return currentTotal + size;
}
