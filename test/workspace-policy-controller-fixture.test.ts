import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('external controller fixture retries the same versioned request without persisting credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acornops-controller-'));
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ workspaceName: 'Test workspace', policyVersion: 8 }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
    res.end(JSON.stringify({ changed: true, policy: { policyVersion: 9, lifecycleStatus: 'suspended' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/examples/workspace-policy-controller.mjs', ...args], {
      env: { ...process.env, ACORNOPS_ADMIN_BASE_URL: `http://127.0.0.1:${address.port}`, ACORNOPS_ADMIN_TOKEN: 'fixture-token' }
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  try {
    const file = join(directory, 'request.json');
    assert.equal((await run(['prepare', 'workspace-1', 'suspend', '-', file])).code, 0);
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.includes('fixture-token'), false);
    const prepared = JSON.parse(raw);
    assert.equal(prepared.body.source, 'external');
    assert.equal(prepared.body.expectedPolicyVersion, 8);
    assert.equal(prepared.body.workspaceName, 'Test workspace');
    assert.equal((await run(['apply', file])).code, 0);
    assert.equal((await run(['apply', file])).code, 0);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal((await run(['prepare', 'workspace-1', 'restore', '-', file])).code, 1);
    assert.equal(await readFile(file, 'utf8'), raw);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
