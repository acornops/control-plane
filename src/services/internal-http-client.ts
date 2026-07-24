import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { URL } from 'node:url';
import { config } from '../config.js';
import { internalClientTlsOptions } from '../infra/internal-tls.js';

export interface InternalHttpResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export async function internalFetch(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<InternalHttpResponse> {
  const parsed = new URL(url);
  if (!config.INTERNAL_TRANSPORT_TLS_ENABLED || parsed.protocol !== 'https:') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (init.signal?.aborted) {
    throw new Error('Internal request aborted');
  }
  const body = typeof init.body === 'string' || init.body instanceof Buffer ? init.body : undefined;
  const headers = new Headers(init.headers);
  const options: RequestOptions = {
    ...internalClientTlsOptions(),
    method: init.method || 'GET',
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: `${parsed.pathname}${parsed.search}`,
    headers: Object.fromEntries(headers.entries())
  };

  return await new Promise<InternalHttpResponse>((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(options, (res) => {
      const status = res.statusCode || 500;
      const body = [204, 205, 304].includes(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }
      const response = new Response(body, {
        status,
        headers: responseHeaders
      });
      resolve({
        ok: response.ok,
        status: response.status,
        body: response.body,
        headers: response.headers,
        text: () => response.text(),
        json: () => response.json()
      });
    });
    const abortRequest = () => req.destroy(new Error('Internal request aborted'));
    if (init.signal?.aborted) {
      abortRequest();
    } else {
      init.signal?.addEventListener('abort', abortRequest, { once: true });
    }
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Internal request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.on('close', () => init.signal?.removeEventListener('abort', abortRequest));
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
