import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createServer } from 'node:http';
import { createInternalApp } from '../src/internal-app.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';

afterEach(() => mock.restoreAll());

test('cancellation status authenticates service calls and validates bounded distinct IDs before querying', async () => {
  const calls: unknown[][] = [];
  mock.method(db, 'query', async (...args: unknown[]) => { calls.push(args); return { rows: [{ id: 'cancelled' }] }; });
  const server = createServer(createInternalApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/v1/runs/cancellation-status`;
  try {
    const post = (body: unknown, token = config.ORCH_SERVICE_TOKEN) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await post({ runIds: ['cancelled'] }, 'invalid')).status, 401);
    for (const runIds of [[], ['x', 'x'], [''], [' '.repeat(2)], ['x'.repeat(201)], Array.from({ length: 101 }, (_, i) => String(i))]) {
      assert.equal((await post({ runIds })).status, 400);
    }
    assert.equal(calls.length, 0);
    const response = await post({ runIds: ['cancelled', 'running', 'missing'] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cancelledRunIds: ['cancelled'] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], [['cancelled', 'running', 'missing']]);
    assert.match(String(calls[0][0]), /workflow_runs/);
    assert.match(String(calls[0][0]), /cancellation_requested_at/);
    assert.match(String(calls[0][0]), /cancelling/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
