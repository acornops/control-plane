import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { URL } from 'node:url';
import { config } from '../config.js';
import { internalClientTlsOptions } from '../infra/internal-tls.js';

export interface InternalHttpResponse {
  ok: boolean;
  status: number;
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
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => payload,
          json: async () => JSON.parse(payload)
        });
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
