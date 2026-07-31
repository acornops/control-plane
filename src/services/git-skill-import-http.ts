import { GitSkillImportError } from './git-skill-import-contracts.js';

const MAX_GITLAB_TREE_PAGES = 10;
const MAX_GITLAB_TREE_PAGE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export function decodeBase64Utf8(value: string): string {
  const normalized = value.replace(/\s/g, '');
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!validBase64.test(normalized)) {
    throw invalidProviderContent('GitHub returned invalid base64 file content.');
  }
  return decodeUtf8(Buffer.from(normalized, 'base64'), 'GitHub returned a file that is not valid UTF-8.');
}

export async function gitJson<T>(
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

export async function gitText(
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

export async function gitLabPages<T>(
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
