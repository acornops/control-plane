import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { gzipSync } from 'node:zlib';
import pino from 'pino';
import express, { type Request } from 'express';
import { createApp } from '../src/app.js';
import { createInternalApp } from '../src/internal-app.js';
import { logger } from '../src/logger.js';
import { jsonBodyParser } from '../src/middleware/json-body-parser.js';

it('preserves exact valid JSON bytes for webhook signature verification', async () => {
  const app = express();
  app.use(jsonBodyParser());
  app.post('/probe', (req, res) => res.json({ body: req.body, rawBody: (req as Request & { rawBody?: string }).rawBody }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const rawBody = '{ "event": "signed", "value": 1 }\n';
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzipSync(rawBody)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { body: { event: 'signed', value: 1 }, rawBody });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

for (const [name, create] of [['public', createApp], ['internal', createInternalApp]] as const) {
  it(`${name} rejects invalid bodies without exposing them in serialized logs`, async (t) => {
    const secret = 'synthetic-parser-secret';
    const malformed = `{"password":"${secret}",`;
    const logs: string[] = [];
    const stream = (logger as unknown as Record<symbol, { write(chunk: string): void }>)[pino.symbols.streamSym];
    t.mock.method(stream, 'write', (chunk: string) => { logs.push(chunk); });
    const server = create().listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const [body, headers, expectedStatus] of [
        [malformed, {}, 400],
        [gzipSync(malformed), { 'Content-Encoding': 'gzip' }, 400],
        [Buffer.from('invalid gzip'), { 'Content-Encoding': 'gzip' }, 400],
        [`{"password":"${secret}${'x'.repeat(4 * 1024 * 1024)}"}`, {}, 413],
        [malformed, { 'Content-Type': 'application/json; charset=invalid' }, 415]
      ] as const) {
        logs.length = 0;
        const response = await fetch(`${baseUrl}/not-a-route`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'parser-security-test', ...headers }, body
        });
        const payload = await response.json();
        assert.doesNotMatch(logs.join(''), new RegExp(secret));
        assert.ok(logs.length > 0, 'parser failures must retain safe diagnostic metadata');
        assert.equal(response.status, expectedStatus);
        assert.equal(payload.error.retryable, false);
        assert.equal(payload.error.request_id, 'parser-security-test');
        assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret));
        assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it(`${name} JSON parser handles compressed bodies without taking down health checks`, async () => {
    const server = create().listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const valid = gzipSync('{"probe":true}');
      for (const body of [valid, Buffer.concat([valid, Buffer.from('trailing bytes')]), Buffer.from('invalid gzip')]) {
        const response = await fetch(`${baseUrl}/not-a-route`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body
        });
        await response.arrayBuffer();
        if (body === valid) assert.equal(response.status, 404);
        else assert.ok(response.status >= 400);
        const health = await fetch(`${baseUrl}/health`);
        assert.equal(health.status, 200);
        assert.equal((await health.json()).status, 'ok');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
