import { config } from '../config.js';
import {
  GitImportHost,
  GitImportProvider,
  matchGitImportHost
} from '../config-git-imports.js';

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

interface ParsedRepository {
  provider: GitImportProvider;
  repoUrl: string;
  apiBaseUrl: string;
  owner?: string;
  repo?: string;
  projectPath?: string;
  embeddedPathSegments: string[];
}

export interface GitSkillResolveInput {
  repoUrl: string;
  ref?: string;
  subpath?: string;
}

export interface ResolvedGitSkill {
  files: Array<{ path: string; content: string }>;
  source: {
    provider: GitImportProvider;
    repoUrl: string;
    ref: string;
    subpath?: string;
    commitSha: string;
  };
}

export type GitSkillImportErrorCode =
  | 'INVALID_REPO_URL'
  | 'UNSUPPORTED_GIT_HOST'
  | 'INVALID_GIT_REF'
  | 'INVALID_GIT_SUBPATH'
  | 'INVALID_SKILL_BUNDLE'
  | 'GIT_ACCESS_DENIED'
  | 'GIT_SOURCE_NOT_FOUND'
  | 'GIT_RATE_LIMITED'
  | 'GIT_PROVIDER_UNAVAILABLE'
  | 'GIT_PROVIDER_FAILED';

export class GitSkillImportError extends Error {
  constructor(
    message: string,
    readonly code: GitSkillImportErrorCode,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitSkillImportError';
  }
}

const MAX_FILES = 16;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_GITLAB_TREE_PAGES = 10;
const MAX_EMBEDDED_REF_CANDIDATES = 8;
const MAX_GITHUB_SUBPATH_SEGMENTS = 16;
const MAX_SMALL_JSON_BYTES = 64 * 1024;
const MAX_BLOB_JSON_BYTES = 64 * 1024;
const MAX_GITHUB_TREE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GITLAB_TREE_PAGE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
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

function parseGitHubRepository(rawUrl: string, host: GitImportHost): ParsedRepository {
  const segments = repositoryPathSegments(rawUrl, host.webBaseUrl);
  const locationKind = segments[2];
  if (segments.length < 2 || (segments.length > 2 && locationKind !== 'tree' && locationKind !== 'blob')) {
    throw new GitSkillImportError(
      'GitHub URL must point to a repository, repository folder, or SKILL.md.',
      'INVALID_REPO_URL',
      400
    );
  }
  const embeddedPathSegments = locationKind === 'tree' || locationKind === 'blob'
    ? segments.slice(3)
    : [];
  if ((locationKind === 'tree' || locationKind === 'blob') && embeddedPathSegments.length === 0) {
    throw new GitSkillImportError(
      'GitHub folder or file URL must include a ref.',
      'INVALID_GIT_REF',
      400
    );
  }
  if (locationKind === 'blob') {
    if (embeddedPathSegments.at(-1) !== 'SKILL.md') {
      throw new GitSkillImportError(
        'GitHub file URL must point to SKILL.md.',
        'INVALID_REPO_URL',
        400
      );
    }
    embeddedPathSegments.pop();
  }
  const owner = validRepositorySegment(segments[0]);
  const repo = validRepositorySegment(stripGitSuffix(segments[1]));
  return {
    provider: 'github',
    owner,
    repo,
    repoUrl: repositoryUrl(host.webBaseUrl, [owner, repo]),
    apiBaseUrl: host.apiBaseUrl,
    embeddedPathSegments
  };
}

function parseGitLabRepository(rawUrl: string, host: GitImportHost): ParsedRepository {
  const segments = repositoryPathSegments(rawUrl, host.webBaseUrl);
  const separatorIndex = segments.indexOf('-');
  const projectSegments = separatorIndex === -1 ? segments : segments.slice(0, separatorIndex);
  const locationKind = separatorIndex === -1 ? undefined : segments[separatorIndex + 1];
  if (projectSegments.length < 2 || (separatorIndex !== -1 && locationKind !== 'tree' && locationKind !== 'blob')) {
    throw new GitSkillImportError(
      'GitLab URL must point to a project, project folder, or SKILL.md.',
      'INVALID_REPO_URL',
      400
    );
  }
  const embeddedPathSegments = separatorIndex === -1 ? [] : segments.slice(separatorIndex + 2);
  if (separatorIndex !== -1 && embeddedPathSegments.length === 0) {
    throw new GitSkillImportError(
      'GitLab folder or file URL must include a ref.',
      'INVALID_GIT_REF',
      400
    );
  }
  if (locationKind === 'blob') {
    if (embeddedPathSegments.at(-1) !== 'SKILL.md') {
      throw new GitSkillImportError(
        'GitLab file URL must point to SKILL.md.',
        'INVALID_REPO_URL',
        400
      );
    }
    embeddedPathSegments.pop();
  }
  const normalizedProjectSegments = projectSegments.map((segment, index) =>
    validRepositorySegment(index === projectSegments.length - 1 ? stripGitSuffix(segment) : segment)
  );
  return {
    provider: 'gitlab',
    projectPath: normalizedProjectSegments.join('/'),
    repoUrl: repositoryUrl(host.webBaseUrl, normalizedProjectSegments),
    apiBaseUrl: host.apiBaseUrl,
    embeddedPathSegments
  };
}

function repositoryPathSegments(rawUrl: string, webBaseUrl: string): string[] {
  const url = new URL(rawUrl);
  const base = new URL(webBaseUrl);
  const relativePath = url.pathname.slice(base.pathname.replace(/\/+$/g, '').length);
  try {
    return relativePath.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new GitSkillImportError(
      'Repository URL contains an invalid encoded path segment.',
      'INVALID_REPO_URL',
      400
    );
  }
}

function normalizeLocation(
  input: GitSkillResolveInput,
  parsed: ParsedRepository
): { ref?: string; subpath?: string } {
  const explicitRef = optionalString(input.ref);
  const explicitSubpath = optionalString(input.subpath);
  if (parsed.embeddedPathSegments.length === 0) {
    return { ref: explicitRef, subpath: explicitSubpath };
  }
  if (explicitRef) {
    const refSegments = explicitRef.split('/').filter(Boolean);
    const matches = refSegments.every((segment, index) => parsed.embeddedPathSegments[index] === segment);
    if (!matches) {
      throw new GitSkillImportError(
        'Repository folder URL includes a different ref.',
        'INVALID_GIT_REF',
        400
      );
    }
    const embeddedSubpath = parsed.embeddedPathSegments.slice(refSegments.length).join('/') || undefined;
    if (explicitSubpath && embeddedSubpath && normalizeSubpath(explicitSubpath) !== embeddedSubpath) {
      throw new GitSkillImportError(
        'Repository folder URL includes a different subpath.',
        'INVALID_GIT_SUBPATH',
        400
      );
    }
    return { ref: explicitRef, subpath: explicitSubpath || embeddedSubpath };
  }
  return {
    ref: parsed.embeddedPathSegments[0],
    subpath: explicitSubpath || parsed.embeddedPathSegments.slice(1).join('/') || undefined
  };
}

async function resolveLocation(
  input: GitSkillResolveInput,
  parsed: ParsedRepository,
  rawDefaultRef: string,
  loadCommit: (ref: string) => Promise<string>
): Promise<{ ref: string; subpath?: string; commitSha: string }> {
  const explicitRef = optionalString(input.ref);
  const defaultRef = validRef(rawDefaultRef);
  if (explicitRef || parsed.embeddedPathSegments.length === 0) {
    const normalized = normalizeLocation(input, parsed);
    const ref = validRef(normalized.ref || defaultRef);
    if (!ref) {
      throw new GitSkillImportError(
        'Unable to determine a Git ref for the requested repository.',
        'INVALID_GIT_REF',
        400
      );
    }
    return {
      ref,
      subpath: normalized.subpath,
      commitSha: await loadCommit(ref)
    };
  }

  const embedded = parsed.embeddedPathSegments;
  const defaultRefSegments = defaultRef?.split('/').filter(Boolean) || [];
  if (defaultRef && pathStartsWith(embedded, defaultRefSegments)) {
    return {
      ref: defaultRef,
      subpath: embeddedSubpath(input.subpath, embedded.slice(defaultRefSegments.length)),
      commitSha: await loadCommit(defaultRef)
    };
  }

  const candidateCount = Math.min(embedded.length, MAX_EMBEDDED_REF_CANDIDATES);
  for (let length = 1; length <= candidateCount; length += 1) {
    const ref = validRef(embedded.slice(0, length).join('/'));
    if (!ref) continue;
    try {
      return {
        ref,
        subpath: embeddedSubpath(input.subpath, embedded.slice(length)),
        commitSha: await loadCommit(ref)
      };
    } catch (error) {
      if (error instanceof GitSkillImportError && error.code === 'GIT_SOURCE_NOT_FOUND') continue;
      throw error;
    }
  }

  throw new GitSkillImportError(
    'Unable to resolve the Git ref encoded in the repository URL.',
    'INVALID_GIT_REF',
    400
  );
}

function embeddedSubpath(explicitSubpath: string | undefined, segments: string[]): string | undefined {
  const explicit = optionalString(explicitSubpath);
  const embedded = segments.join('/') || undefined;
  if (explicit && embedded && normalizeSubpath(explicit) !== normalizeSubpath(embedded)) {
    throw new GitSkillImportError(
      'Repository folder URL includes a different subpath.',
      'INVALID_GIT_SUBPATH',
      400
    );
  }
  return explicit || embedded;
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((segment, index) => path[index] === segment);
}

function validRef(value: string | undefined): string | undefined {
  const ref = optionalString(value);
  if (!ref) return undefined;
  if (ref.length > 255 || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new GitSkillImportError(
      'Git ref must be 255 characters or fewer and contain no control characters.',
      'INVALID_GIT_REF',
      400
    );
  }
  return ref;
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

function normalizeSubpath(rawSubpath: string | undefined): string {
  const value = String(rawSubpath || '').replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '');
  if (!value) return '';
  if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new GitSkillImportError(
      'Git subpath contains an invalid path segment.',
      'INVALID_GIT_SUBPATH',
      400
    );
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  return String(value || '').trim() || undefined;
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

function validRepositorySegment(value: string): string {
  if (!value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitSkillImportError(
      'Repository URL contains an invalid owner, group, or repository segment.',
      'INVALID_REPO_URL',
      400
    );
  }
  return value;
}

function repositoryUrl(webBaseUrl: string, segments: string[]): string {
  return `${webBaseUrl}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
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

function decodeBase64Utf8(value: string): string {
  const normalized = value.replace(/\s/g, '');
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!validBase64.test(normalized)) {
    throw invalidProviderContent('GitHub returned invalid base64 file content.');
  }
  return decodeUtf8(Buffer.from(normalized, 'base64'), 'GitHub returned a file that is not valid UTF-8.');
}

async function gitJson<T>(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxBytes: number
): Promise<T> {
  return withGitResponse(
    url,
    fetchImpl,
    signal,
    { Accept: 'application/json' },
    (response) => readJsonResponse<T>(
      response,
      maxBytes,
      'Git provider returned an unexpected response.'
    )
  );
}

async function gitText(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxBytes: number
): Promise<string> {
  return withGitResponse(url, fetchImpl, signal, undefined, async (response) => {
    const body = await readBoundedResponse(response, maxBytes);
    return decodeUtf8(body, 'Git provider returned a file that is not valid UTF-8.');
  });
}

async function gitLabPages<T>(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<T[]> {
  const entries: T[] = [];
  const url = new URL(initialUrl);
  for (let page = 0; page < MAX_GITLAB_TREE_PAGES; page += 1) {
    const result = await withGitResponse(
      url.toString(),
      fetchImpl,
      signal,
      { Accept: 'application/json' },
      async (response) => ({
        pageEntries: await readJsonResponse<T[]>(
          response,
          MAX_GITLAB_TREE_PAGE_BYTES,
          'GitLab returned an unexpected repository tree response.'
        ),
        nextPage: response.headers.get('x-next-page')
      })
    );
    if (!Array.isArray(result.pageEntries)) {
      throw new GitSkillImportError(
        'GitLab returned an unexpected repository tree response.',
        'GIT_PROVIDER_FAILED',
        502
      );
    }
    entries.push(...result.pageEntries);
    if (!result.nextPage) return entries;
    url.searchParams.set('page', result.nextPage);
  }
  throw new GitSkillImportError(
    'GitLab returned too many repository tree pages.',
    'INVALID_SKILL_BUNDLE',
    400
  );
}

async function withGitResponse<T>(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  headers: Record<string, string> | undefined,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abortFromDeadline = () => controller.abort(signal.reason);
  if (signal.aborted) abortFromDeadline();
  else signal.addEventListener('abort', abortFromDeadline, { once: true });
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'AcornOps-Control-Plane',
        ...headers
      },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) throw gitResponseError(response);
    return await consume(response);
  } catch (error) {
    if (error instanceof GitSkillImportError) throw error;
    throw new GitSkillImportError(
      'Git provider could not be reached.',
      'GIT_PROVIDER_UNAVAILABLE',
      503
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromDeadline);
  }
}

function gitResponseError(response: Response): GitSkillImportError {
  if (response.status === 429
    || (response.status === 403
      && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    return new GitSkillImportError(
      'Git provider rate limit reached. Wait and try again.',
      'GIT_RATE_LIMITED',
      429
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new GitSkillImportError(
      'Git provider denied access. Only anonymously readable repositories are supported.',
      'GIT_ACCESS_DENIED',
      403
    );
  }
  if (response.status === 404) {
    return new GitSkillImportError(
      'Repository, ref, or subpath was not found.',
      'GIT_SOURCE_NOT_FOUND',
      404
    );
  }
  if (response.status >= 500) {
    return new GitSkillImportError(
      'Git provider is temporarily unavailable.',
      'GIT_PROVIDER_UNAVAILABLE',
      503
    );
  }
  return new GitSkillImportError(
    'Git provider request failed.',
    'GIT_PROVIDER_FAILED',
    502
  );
}

async function readJsonResponse<T>(
  response: Response,
  maxBytes: number,
  message: string
): Promise<T> {
  try {
    const body = await readBoundedResponse(response, maxBytes);
    return JSON.parse(decodeUtf8(body, message)) as T;
  } catch (error) {
    if (error instanceof GitSkillImportError) throw error;
    throw invalidProviderContent(message);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw invalidProviderContent(`Git provider response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw invalidProviderContent(`Git provider response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function decodeUtf8(value: Uint8Array, message: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw invalidProviderContent(message);
  }
}

function invalidProviderContent(message: string): GitSkillImportError {
  return new GitSkillImportError(message, 'GIT_PROVIDER_FAILED', 502);
}
