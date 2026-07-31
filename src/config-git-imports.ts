import { z } from 'zod';

export type GitImportProvider = 'github' | 'gitlab';

export interface GitImportHost {
  provider: GitImportProvider;
  webBaseUrl: string;
  apiBaseUrl: string;
}

export const DEFAULT_GIT_IMPORT_HOSTS: GitImportHost[] = [
  {
    provider: 'github',
    webBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com'
  },
  {
    provider: 'gitlab',
    webBaseUrl: 'https://gitlab.com',
    apiBaseUrl: 'https://gitlab.com/api/v4'
  }
];

export const DEFAULT_GIT_IMPORT_HOSTS_JSON = JSON.stringify(DEFAULT_GIT_IMPORT_HOSTS);

export const gitImportHostsJsonSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().default(DEFAULT_GIT_IMPORT_HOSTS_JSON).superRefine((value, ctx) => {
    try {
      parseGitImportHosts(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid Git import host configuration'
      });
    }
  })
);

const gitImportHostSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  webBaseUrl: z.string().url().max(2048),
  apiBaseUrl: z.string().url().max(2048)
}).strict();

function normalizeBaseUrl(rawUrl: string, field: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`${field} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must not contain credentials, query parameters, or fragments`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/g, '')}`;
}

function normalizeGitImportHost(input: z.infer<typeof gitImportHostSchema>): GitImportHost {
  const webBaseUrl = normalizeBaseUrl(input.webBaseUrl, 'webBaseUrl');
  const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl, 'apiBaseUrl');
  const expectedSuffix = input.provider === 'github' ? '/api/v3' : '/api/v4';
  const publicGitHubApi = input.provider === 'github' && apiBaseUrl === 'https://api.github.com';
  if (!publicGitHubApi && !new URL(apiBaseUrl).pathname.endsWith(expectedSuffix)) {
    throw new Error(`apiBaseUrl must end with ${expectedSuffix} for ${input.provider}`);
  }
  return { provider: input.provider, webBaseUrl, apiBaseUrl };
}

export function parseGitImportHosts(rawJson: string | undefined): GitImportHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson || DEFAULT_GIT_IMPORT_HOSTS_JSON) as unknown;
  } catch {
    throw new Error('GIT_IMPORT_HOSTS_JSON must be valid JSON');
  }
  const result = z.array(gitImportHostSchema).min(1).max(32).safeParse(parsed);
  if (!result.success) {
    throw new Error('GIT_IMPORT_HOSTS_JSON must contain 1-32 valid Git host definitions');
  }
  const hosts = result.data.map(normalizeGitImportHost);
  const seen = new Set<string>();
  for (const host of hosts) {
    const key = host.webBaseUrl.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`GIT_IMPORT_HOSTS_JSON contains duplicate webBaseUrl ${host.webBaseUrl}`);
    }
    seen.add(key);
  }
  return hosts.sort((left, right) => right.webBaseUrl.length - left.webBaseUrl.length);
}

export function matchGitImportHost(rawUrl: string, hosts: readonly GitImportHost[]): GitImportHost | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  return hosts.find((host) => {
    const base = new URL(host.webBaseUrl);
    if (url.origin.toLowerCase() !== base.origin.toLowerCase()) return false;
    const basePath = base.pathname.replace(/\/+$/g, '');
    return !basePath || basePath === '/'
      ? true
      : url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
  });
}

export function isConfiguredGitImportSource(
  provider: GitImportProvider | undefined,
  repoUrl: string | undefined,
  hosts: readonly GitImportHost[]
): boolean {
  return Boolean(repoUrl && matchGitImportHost(repoUrl, hosts)?.provider === provider);
}
