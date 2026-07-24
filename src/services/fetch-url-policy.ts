import net from 'node:net';

export const FETCH_TOOL_ID = 'http.fetch.get';
export const MAX_FETCH_URL_PATTERNS = 20;
export const MAX_FETCH_URL_PATTERN_LENGTH = 2_048;
export const MAX_FETCH_URL_LENGTH = 8_192;

export interface FetchToolConfig {
  allowedUrlPatterns: string[];
}

export interface FetchToolInput {
  url: string;
}

export class FetchUrlPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FetchUrlPolicyError';
  }
}

function parseHttpsUrl(rawValue: string, maximumLength: number, pattern: boolean): URL {
  const value = rawValue.trim();
  if (!value || value.length > maximumLength) {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      pattern
        ? `Each Fetch URL pattern must contain between 1 and ${maximumLength} characters.`
        : `Fetch URLs may contain at most ${maximumLength} characters.`
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      pattern ? 'Fetch URL patterns must be complete absolute URLs.' : 'Fetch requires a complete absolute URL.'
    );
  }
  if (url.protocol !== 'https:') {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      'Fetch supports HTTPS URLs only.'
    );
  }
  if (url.username || url.password) {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      'Fetch URLs must not include credentials.'
    );
  }
  if (url.hash) {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      'Fetch URLs must not include fragments.'
    );
  }
  const hostname = url.hostname.replace(/^\[(.*)]$/, '$1');
  if (net.isIP(hostname) !== 0) {
    throw new FetchUrlPolicyError(
      pattern ? 'FETCH_PATTERN_INVALID' : 'FETCH_URL_INVALID',
      'Fetch URLs must use a DNS hostname.'
    );
  }
  if (pattern) {
    const suffix = value.slice('https://'.length);
    const authorityEnd = [suffix.indexOf('/'), suffix.indexOf('?')]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? suffix.length;
    const authority = suffix.slice(0, authorityEnd);
    if (authority.includes('*')) {
      throw new FetchUrlPolicyError('FETCH_PATTERN_INVALID', 'Wildcards are allowed only in the URL path or query.');
    }
  } else if (value.includes('*')) {
    throw new FetchUrlPolicyError('FETCH_URL_INVALID', 'The requested Fetch URL must not contain wildcards.');
  }
  return url;
}

function canonicalUrl(url: URL): string {
  url.hostname = url.hostname.toLowerCase();
  if (url.port === '443') url.port = '';
  return `${url.origin}${url.pathname}${url.search}`;
}

export function normalizeFetchUrlPattern(rawPattern: string): string {
  const normalized = canonicalUrl(parseHttpsUrl(rawPattern, MAX_FETCH_URL_PATTERN_LENGTH, true));
  if (normalized.length > MAX_FETCH_URL_PATTERN_LENGTH) {
    throw new FetchUrlPolicyError(
      'FETCH_PATTERN_INVALID',
      `Each Fetch URL pattern may contain at most ${MAX_FETCH_URL_PATTERN_LENGTH} characters after normalization.`
    );
  }
  return normalized;
}

export function normalizeFetchToolConfig(value: unknown): FetchToolConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FetchUrlPolicyError('FETCH_CONFIG_INVALID', 'Fetch configuration must be an object.');
  }
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== 'allowedUrlPatterns')) {
    throw new FetchUrlPolicyError(
      'FETCH_CONFIG_INVALID',
      'Fetch configuration accepts only allowedUrlPatterns.'
    );
  }
  const allowed = config.allowedUrlPatterns;
  if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > MAX_FETCH_URL_PATTERNS) {
    throw new FetchUrlPolicyError(
      'FETCH_CONFIG_INVALID',
      `Fetch requires between 1 and ${MAX_FETCH_URL_PATTERNS} allowed URL patterns.`
    );
  }
  if (allowed.some((item) => typeof item !== 'string')) {
    throw new FetchUrlPolicyError('FETCH_CONFIG_INVALID', 'Fetch URL patterns must be strings.');
  }
  const normalized = allowed.map((item) => normalizeFetchUrlPattern(item));
  if (new Set(normalized).size !== normalized.length) {
    throw new FetchUrlPolicyError('FETCH_CONFIG_INVALID', 'Fetch URL patterns must be unique.');
  }
  return { allowedUrlPatterns: normalized.sort((left, right) => left.localeCompare(right)) };
}

export function canonicalizeFetchUrl(rawUrl: string): string {
  const normalized = canonicalUrl(parseHttpsUrl(rawUrl, MAX_FETCH_URL_LENGTH, false));
  if (normalized.length > MAX_FETCH_URL_LENGTH) {
    throw new FetchUrlPolicyError(
      'FETCH_URL_INVALID',
      `Fetch URLs may contain at most ${MAX_FETCH_URL_LENGTH} characters after normalization.`
    );
  }
  return normalized;
}

export function normalizeFetchToolInput(value: unknown): FetchToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FetchUrlPolicyError('FETCH_INPUT_INVALID', 'Fetch accepts exactly one string url argument.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.url !== 'string') {
    throw new FetchUrlPolicyError('FETCH_INPUT_INVALID', 'Fetch accepts exactly one string url argument.');
  }
  return { url: input.url };
}

function pathAndQuery(value: string): string {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function anchoredGlobMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let lastWildcardIndex = -1;
  let wildcardValueIndex = -1;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      lastWildcardIndex = patternIndex;
      wildcardValueIndex = valueIndex;
      patternIndex += 1;
      continue;
    }
    if (lastWildcardIndex >= 0) {
      patternIndex = lastWildcardIndex + 1;
      wildcardValueIndex += 1;
      valueIndex = wildcardValueIndex;
      continue;
    }
    return false;
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

export function fetchUrlMatchesPattern(rawUrl: string, rawPattern: string): boolean {
  const url = canonicalizeFetchUrl(rawUrl);
  const pattern = normalizeFetchUrlPattern(rawPattern);
  const parsedUrl = new URL(url);
  const parsedPattern = new URL(pattern);
  return parsedUrl.origin === parsedPattern.origin
    && anchoredGlobMatches(pathAndQuery(url), pathAndQuery(pattern));
}

export function assertFetchUrlAllowed(rawUrl: string, config: FetchToolConfig): string {
  const url = canonicalizeFetchUrl(rawUrl);
  if (!config.allowedUrlPatterns.some((pattern) => fetchUrlMatchesPattern(url, pattern))) {
    throw new FetchUrlPolicyError('FETCH_URL_NOT_ALLOWED', 'The requested URL is not allowed for this Agent.');
  }
  return url;
}
