import type { GitImportProvider } from '../config-git-imports.js';

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
