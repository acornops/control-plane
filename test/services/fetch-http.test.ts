import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  fetchPublicHttpGet,
  FetchHttpError,
  readFetchHttpResponse
} from '../../src/services/fetch-http.js';

function response(
  body: string | Buffer,
  statusCode: number,
  headers: IncomingHttpHeaders
): Readable & { statusCode?: number; headers: IncomingHttpHeaders } {
  return Object.assign(Readable.from([body]), { statusCode, headers });
}

describe('Fetch HTTP response policy', () => {
  it('returns JSON and text while preserving non-2xx response status', async () => {
    const json = await readFetchHttpResponse(
      'https://api.example.com/status',
      response('{"ok":false}', 503, { 'content-type': 'application/problem+json; charset=utf-8' })
    );
    assert.equal(json.status, 503);
    assert.deepEqual(json.data, { ok: false });

    const text = await readFetchHttpResponse(
      'https://api.example.com/status',
      response('temporarily unavailable', 200, { 'content-type': 'text/plain' })
    );
    assert.equal(text.data, 'temporarily unavailable');
  });

  it('rejects redirects, unsupported media, invalid JSON, and unsupported encodings', async () => {
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response('', 302, { location: 'https://other.example.com' })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_REDIRECT_BLOCKED'
    );
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response('binary', 200, { 'content-type': 'application/octet-stream' })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_MEDIA_TYPE_UNSUPPORTED'
    );
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response('{broken', 200, { 'content-type': 'application/json' })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_JSON_INVALID'
    );
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response('text', 200, { 'content-type': 'text/plain', 'content-encoding': 'compress' })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_CONTENT_ENCODING_UNSUPPORTED'
    );
  });

  it('applies the 256 KiB limit after decompression', async () => {
    const compressed = gzipSync('x'.repeat(256 * 1024 + 1));
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response(compressed, 200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_RESPONSE_TOO_LARGE'
    );
  });

  it('returns a stable error for malformed compressed responses', async () => {
    await assert.rejects(
      () => readFetchHttpResponse(
        'https://api.example.com/status',
        response('not a gzip stream', 200, {
          'content-type': 'text/plain',
          'content-encoding': 'gzip'
        })
      ),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_RESPONSE_DECODE_FAILED'
    );
  });

  it('applies the timeout to DNS resolution', async () => {
    await assert.rejects(
      () => fetchPublicHttpGet('https://api.example.com/status', {
        resolveEndpoint: async () => await new Promise(() => undefined),
        timeoutMs: 10
      }),
      (error) => error instanceof FetchHttpError && error.code === 'FETCH_TIMEOUT'
    );
  });
});
