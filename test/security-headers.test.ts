import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { renderSwaggerUiHtml } from '../src/docs/swagger-ui.js';

async function withTestServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('security headers', () => {
  it('sets browser hardening headers on API responses', async () => {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('content-security-policy'),
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
      assert.equal(
        response.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains'
      );
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
    });
  });

  it('renders API docs scripts with a CSP nonce hook', () => {
    const html = renderSwaggerUiHtml('/openapi.json', 'test-nonce');

    assert.match(html, /script nonce="test-nonce" src="https:\/\/unpkg\.com\/swagger-ui-dist@5\.20\.2\/swagger-ui-bundle\.js"/);
    assert.match(html, /<script nonce="test-nonce">/);
  });
});
