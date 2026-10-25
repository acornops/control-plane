import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { createInternalApp } from '../src/internal-app.js';

for (const [name, create] of [['public', createApp], ['internal', createInternalApp]] as const) {
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
