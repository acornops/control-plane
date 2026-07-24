import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import {
  createPinnedLookup,
  resolveWebhookEndpoint,
  WebhookDeliveryPolicyError
} from './webhook-delivery.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_RESPONSE_BYTES = 256 * 1024;

export interface FetchHttpResult {
  url: string;
  status: number;
  contentType: string;
  data: unknown;
  responseSizeBytes: number;
  retrievedAt: string;
}

export class FetchHttpError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message);
    this.name = 'FetchHttpError';
  }
}

function acceptedContentType(rawValue: string | undefined): {
  contentType: string;
  json: boolean;
} {
  const contentType = (rawValue || '').split(';', 1)[0].trim().toLowerCase();
  const json = contentType === 'application/json'
    || (contentType.startsWith('application/') && contentType.endsWith('+json'));
  if (!json && !contentType.startsWith('text/')) {
    throw new FetchHttpError(
      'FETCH_MEDIA_TYPE_UNSUPPORTED',
      'Fetch responses must use a JSON or text content type.',
      415
    );
  }
  return { contentType, json };
}

function decodedStream(stream: Readable, encodingHeader: string | undefined): Readable {
  const encoding = (encodingHeader || 'identity').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return stream;
  if (encoding === 'gzip') return stream.pipe(createGunzip());
  if (encoding === 'deflate') return stream.pipe(createInflate());
  if (encoding === 'br') return stream.pipe(createBrotliDecompress());
  throw new FetchHttpError(
    'FETCH_CONTENT_ENCODING_UNSUPPORTED',
    'Fetch received an unsupported response content encoding.',
    415
  );
}

async function readBounded(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_FETCH_RESPONSE_BYTES) {
        stream.destroy();
        throw new FetchHttpError(
          'FETCH_RESPONSE_TOO_LARGE',
          'Fetch response exceeds the 256 KiB limit.',
          413
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof FetchHttpError) throw error;
    throw new FetchHttpError(
      'FETCH_RESPONSE_DECODE_FAILED',
      'Fetch could not decode the response body.',
      502
    );
  }
  return Buffer.concat(chunks, size);
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new FetchHttpError('FETCH_TIMEOUT', 'Fetch timed out after 15 seconds.', 504));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(deadline);
        resolve(value);
      },
      (error) => {
        clearTimeout(deadline);
        reject(error);
      }
    );
  });
}

export async function readFetchHttpResponse(
  canonicalUrl: string,
  response: Readable & { statusCode?: number; headers: IncomingHttpHeaders }
): Promise<FetchHttpResult> {
  const status = response.statusCode || 0;
  if (status >= 300 && status < 400) {
    response.resume();
    throw new FetchHttpError('FETCH_REDIRECT_BLOCKED', 'Fetch does not follow redirects.', 502);
  }
  const { contentType, json } = acceptedContentType(
    typeof response.headers['content-type'] === 'string'
      ? response.headers['content-type']
      : undefined
  );
  const body = await readBounded(decodedStream(
    response,
    typeof response.headers['content-encoding'] === 'string'
      ? response.headers['content-encoding']
      : undefined
  ));
  const text = body.toString('utf8');
  let data: unknown = text;
  if (json) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new FetchHttpError('FETCH_JSON_INVALID', 'Fetch received invalid JSON.', 502);
    }
  }
  return {
    url: canonicalUrl,
    status,
    contentType,
    data,
    responseSizeBytes: body.length,
    retrievedAt: new Date().toISOString()
  };
}

export async function fetchPublicHttpGet(
  canonicalUrl: string,
  options: {
    resolveEndpoint?: typeof resolveWebhookEndpoint;
    timeoutMs?: number;
  } = {}
): Promise<FetchHttpResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const startedAt = Date.now();
  let endpoint;
  try {
    endpoint = await withDeadline(
      (options.resolveEndpoint || resolveWebhookEndpoint)(canonicalUrl, { allowedPrivateHosts: [] }),
      timeoutMs
    );
  } catch (error) {
    if (error instanceof FetchHttpError) throw error;
    if (error instanceof WebhookDeliveryPolicyError) {
      throw new FetchHttpError('FETCH_DESTINATION_BLOCKED', 'Fetch destination is not allowed.', 403);
    }
    throw new FetchHttpError('FETCH_DNS_FAILED', 'Fetch destination could not be resolved.');
  }

  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new FetchHttpError('FETCH_TIMEOUT', 'Fetch timed out after 15 seconds.', 504);
  }
  const lookup = createPinnedLookup(endpoint.address, endpoint.family);

  return await new Promise<FetchHttpResult>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (error?: unknown, value?: FetchHttpResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = https.request({
      protocol: 'https:',
      hostname: endpoint.hostname,
      port: endpoint.url.port || undefined,
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: 'GET',
      headers: {
        accept: 'application/json, text/*;q=0.9, application/*+json;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': 'AcornOps-Fetch/1.0'
      },
      lookup,
      servername: endpoint.hostname,
      timeout: remainingMs
    }, async (response) => {
      try {
        finish(undefined, await readFetchHttpResponse(canonicalUrl, response));
      } catch (error) {
        response.destroy();
        finish(error);
      }
    });
    req.on('timeout', () => {
      const error = new FetchHttpError('FETCH_TIMEOUT', 'Fetch timed out after 15 seconds.', 504);
      finish(error);
      req.destroy(error);
    });
    req.on('error', (error) => {
      finish(error instanceof FetchHttpError
        ? error
        : new FetchHttpError('FETCH_REQUEST_FAILED', 'Fetch request failed.'));
    });
    deadline = setTimeout(() => {
      const error = new FetchHttpError('FETCH_TIMEOUT', 'Fetch timed out after 15 seconds.', 504);
      finish(error);
      req.destroy(error);
    }, remainingMs);
    req.end();
  });
}
