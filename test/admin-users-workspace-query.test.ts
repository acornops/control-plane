import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { listUsers } from '../src/controllers/admin-controller.js';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { encodeCursor } from '../src/utils/pagination.js';

afterEach(() => mock.restoreAll());

function response() {
  return { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
}

test('user workspace search is normalized, paginated and bound to the cursor filters', async () => {
  const options: any[] = [];
  mock.method(repo, 'listAdminUsers', async (input) => {
    options.push(input);
    return { items: [], nextCursor: encodeCursor({ signature: input.signature, createdAt: '2026-01-01T00:00:00Z', userId: 'user-1' }) };
  });
  const query = { workspaceQuery: ' Atlas_100% ', q: 'maya', emailVerified: 'true', limit: '25' };
  const first = response();
  await listUsers({ query } as never, first as never, (err) => { if (err) throw err; });
  assert.equal(options[0].workspaceQuery, 'Atlas_100%');
  assert.equal(options[0].q, 'maya');
  assert.equal(options[0].emailVerified, true);
  assert.equal(options[0].limit, 25);
  const second = response();
  await listUsers({ query: { ...query, cursor: first.body.nextCursor } } as never, second as never, (err) => { if (err) throw err; });
  assert.equal(second.statusCode, 200);
  const changed = response();
  await listUsers({ query: { ...query, workspaceQuery: 'Cedar', cursor: first.body.nextCursor } } as never, changed as never, (err) => { if (err) throw err; });
  assert.equal(changed.statusCode, 400);
  assert.equal(changed.body.error.code, 'INVALID_CURSOR');
  assert.equal(options.length, 2);
});

test('malformed workspace filters fail before user discovery', async () => {
  mock.method(repo, 'listAdminUsers', async () => { assert.fail('must not query users'); });
  for (const workspaceQuery of [['Atlas', 'Cedar'], { name: 'Atlas' }, 'x'.repeat(257)]) {
    const res = response();
    await listUsers({ query: { workspaceQuery } } as never, res as never, (err) => { if (err) throw err; });
    assert.equal(res.statusCode, 400);
  }
});

test('workspace user discovery performs one bounded parameterized membership existence query', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  mock.method(db, 'query', async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return { rowCount: 0, rows: [] };
  });
  const res = response();
  await listUsers({ query: { workspaceQuery: 'Atlas_100%', q: 'maya', emailVerified: 'true', limit: '25' } } as never, res as never, (err) => { if (err) throw err; });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /EXISTS[\s\S]*workspace_memberships[\s\S]*JOIN workspaces/);
  assert.match(queries[0].sql, /POSITION\(LOWER\(\$\d\) IN LOWER\(w\.name\)\)/);
  assert.match(queries[0].sql, /POSITION\(LOWER\(\$\d\) IN LOWER\(w\.id\)\)/);
  assert.match(queries[0].sql, /LIMIT \$1/);
  assert.deepEqual(queries[0].params, [26, '%maya%', true, 'Atlas_100%']);
  assert.deepEqual(res.body.items, []);
});
