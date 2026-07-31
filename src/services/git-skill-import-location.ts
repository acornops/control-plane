import type { GitImportHost, GitImportProvider } from '../config-git-imports.js';
import {
  GitSkillImportError,
  type GitSkillResolveInput
} from './git-skill-import-contracts.js';

export interface ParsedRepository {
  provider: GitImportProvider;
  repoUrl: string;
  apiBaseUrl: string;
  owner?: string;
  repo?: string;
  projectPath?: string;
  embeddedPathSegments: string[];
}

const MAX_EMBEDDED_REF_CANDIDATES = 8;

export function parseGitHubRepository(rawUrl: string, host: GitImportHost): ParsedRepository {
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

export function parseGitLabRepository(rawUrl: string, host: GitImportHost): ParsedRepository {
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

export async function resolveLocation(
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

export function normalizeSubpath(rawSubpath: string | undefined): string {
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
