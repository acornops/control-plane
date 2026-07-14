import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { config } from '../config.js';
import { repo } from '../store/repository.js';

const SENSITIVE_FRAGMENTS = ['secret', 'token', 'password', 'passwd', 'credential', 'authorization', 'apikey', 'privatekey', 'cookie', 'session'];
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class ToolResultArtifactTooLargeError extends Error {}
export class ToolResultArtifactConflictError extends Error {}
export class ToolResultArtifactInvalidError extends Error {}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>'],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic <redacted>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1<redacted>@'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '<redacted-private-key>'],
  [/(\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    '$1<redacted>'],
];

function sanitizeText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (sanitized, [pattern, replacement]) => sanitized.replace(pattern, replacement),
    value
  );
}

/** Apply a second bounded redaction pass before artifact persistence. */
export function sanitizeArtifactResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArtifactResult);
  if (typeof value === 'string') return sanitizeText(value);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = sensitiveKey(key) ? '<redacted>' : sanitizeArtifactResult(child);
  }
  return output;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (
    left === right ? 0 : left < right ? -1 : 1
  ))
    .map(([key, child]) => [key, canonicalize(child)]));
}

export async function persistToolResultArtifact(input: {
  runId: string;
  workspaceId: string;
  callId: string;
  toolName: string;
  result: unknown;
  contentType?: string;
}) {
  const contentType = input.contentType || 'application/json';
  if (
    typeof input.callId !== 'string' || input.callId.length < 1 || input.callId.length > 256
    || typeof input.toolName !== 'string' || input.toolName.length < 1 || input.toolName.length > 128
    || !['application/json', 'text/plain'].includes(contentType)
  ) {
    throw new ToolResultArtifactInvalidError('Tool result artifact metadata is invalid');
  }
  if (contentType === 'text/plain' && typeof input.result !== 'string') {
    throw new ToolResultArtifactInvalidError('Plain-text tool result artifacts require a string result');
  }
  const raw = contentType === 'text/plain' ? input.result as string : JSON.stringify(input.result);
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') > config.TOOL_RESULT_ARTIFACT_MAX_BYTES) {
    throw new ToolResultArtifactTooLargeError('Tool result artifact exceeds the configured uncompressed size limit');
  }
  const sanitized = sanitizeArtifactResult(input.result);
  const serialized = contentType === 'text/plain'
    ? sanitized as string
    : JSON.stringify(canonicalize(sanitized));
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > config.TOOL_RESULT_ARTIFACT_MAX_BYTES) {
    throw new ToolResultArtifactTooLargeError('Tool result artifact exceeds the configured uncompressed size limit');
  }
  const compressed = await gzipAsync(bytes, { level: 6 });
  const expiresAt = new Date(Date.now() + config.TOOL_RESULT_ARTIFACT_RETENTION_DAYS * 86400_000).toISOString();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const artifact = await repo.upsertToolResultArtifact({
    id: randomUUID(),
    runId: input.runId,
    workspaceId: input.workspaceId,
    callId: input.callId,
    toolName: input.toolName,
    sha256,
    contentType,
    encoding: 'gzip',
    uncompressedBytes: bytes.length,
    compressedBytes: compressed.length,
    payload: compressed,
    expiresAt,
  });
  if (
    artifact.sha256 !== sha256
    || artifact.toolName !== input.toolName
    || artifact.contentType !== contentType
    || artifact.encoding !== 'gzip'
  ) {
    throw new ToolResultArtifactConflictError('Tool result artifact call ID was already used for a different result');
  }
  return artifact;
}

/** Decode one previously verified gzip artifact for an authorized response. */
export async function decodeToolResultArtifact(
  payload: Buffer, expectedSha256: string, expectedBytes: number
): Promise<Buffer> {
  const decoded = await gunzipAsync(payload, { maxOutputLength: config.TOOL_RESULT_ARTIFACT_MAX_BYTES });
  const digest = createHash('sha256').update(decoded).digest('hex');
  if (decoded.length !== expectedBytes || digest !== expectedSha256) {
    throw new Error('Stored tool result artifact failed its integrity check');
  }
  return decoded;
}
