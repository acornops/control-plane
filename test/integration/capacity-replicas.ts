/** Run explicitly against disposable PostgreSQL/Redis; no live model or MCP calls. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from '../../src/infra/db.js';
import { resetAutomationDatabaseFixtures } from '../helpers/automation-database-fixtures.js';

const children: ChildProcess[] = [];
const diagnostics: string[] = [];
const prefix = `hosted-replica-${randomUUID()}`;
const token = `test-${randomUUID()}`;
const limits = Object.fromEntries(['chat','agent','workflow','autoTriage','insights'].map(pool => [pool, { maxConcurrentRuns: 1, maxOutstandingRuns: 3 }]));
const plans = { defaultPlanKey: 'replica-v1', plans: [{ key: 'replica-v1', name: 'Replica test', quotas: { members: 100, kubernetesClusters: 100, virtualMachines: 100 }, executionLimits: limits }] };
const env = { ...process.env, WORKSPACE_CAPACITY_ENABLED: 'true', WORKSPACE_PLANS_CONFIG_JSON: JSON.stringify(plans),
  ORCH_SERVICE_TOKEN: token, EXECUTION_ENGINE_DISPATCH_TOKEN: token, EXECUTION_DURABILITY_KEY_PREFIX: prefix };
function launch(command: string, args: string[], extra = {}) {
  const child = spawn(command, args, { env: { ...env, ...extra }, stdio: ['ignore','pipe','pipe'] });
  children.push(child);
  child.stdout!.on('data', data => diagnostics.push(String(data)));
  child.stderr!.on('data', data => diagnostics.push(String(data)));
  return child;
}
async function until(check: () => Promise<boolean>, description: string, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
async function controlPlane() {
  const child = launch(process.execPath, ['--import','tsx','test/integration/capacity-control-plane.ts']);
  let output = '';
  return new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('Control plane startup timed out')), 20000);
    child.stdout!.on('data', data => {
      output += String(data);
      const match = output.match(/\{"port":(\d+)\}/);
      if (match) { clearTimeout(timer); resolveUrl(`http://127.0.0.1:${match[1]}`); }
    });
    child.on('error', reject);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
async function engine(cp: string) {
  const port = await freePort();
  launch(resolve('../execution-engine/.venv/bin/python'), ['test/integration/capacity-engine.py'], {
    PYTHONPATH: resolve('../execution-engine'), PROBE_PORT: String(port), ORCH_BASE_URL: cp,
    MAX_CONCURRENT_RUNS: '2', TERMINAL_COMMIT_RETRY_INTERVAL_SECONDS: '1'
  });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }, 'engine health');
  return url;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
async function main() {
try {
  await resetAutomationDatabaseFixtures();
  await db.query('UPDATE workspaces SET plan_key=$1', ['replica-v1']);
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
    VALUES('replica-session','workspace-1','cluster-1','user-1','Replica probe','open',clock_timestamp(),clock_timestamp())`);
  const cps = await Promise.all([controlPlane(), controlPlane()]);
  const engines = await Promise.all(cps.map(engine));
  const admissions = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const runId = randomUUID();
    const response = await post(`${cps[i % 2]}/fixture/admit`, { workspaceId: 'workspace-1', runId, pool: 'chat' });
    return { runId, status: response.status };
  }));
  const accepted = admissions.filter(item => item.status === 201);
  assert.equal(accepted.length, 3);
  assert.ok(admissions.filter(item => item.status !== 201).every(item => item.status === 409));
  const other = randomUUID();
  assert.equal((await post(`${cps[1]}/fixture/admit`, { workspaceId: 'workspace-1', runId: other, pool: 'agent' })).status, 201);
  const runIds = [...accepted.map(item => item.runId), other];
  for (const [i, runId] of runIds.entries()) {
    const response = await post(`${engines[i % 2]}/api/v1/runs`, {
      contract_version: 2, capacity_contract_version: 1, capacity_enabled: true, run_id: runId, workspace_id: 'workspace-1',
      scope_type: 'target', target_id: 'cluster-1', target_type: 'kubernetes', session_id: 'replica-session',
      message_id: runId, requested_at: new Date().toISOString()
    });
    assert.equal(response.status, 202, await response.text());
  }
  let overlapAcrossPools = false;
  await until(async () => {
    const rows = await db.query(`SELECT pool,count(*)::int AS count FROM workspace_run_reservations
      WHERE workspace_id='workspace-1' AND executing_until IS NOT NULL GROUP BY pool`);
    for (const row of rows.rows) assert.ok(row.count <= 1, `Overlapping ${row.pool} grants`);
    if (rows.rows.length === 2) overlapAcrossPools = true;
    const done = await db.query("SELECT count(*)::int AS count FROM runs WHERE workspace_id='workspace-1' AND status='completed'");
    return done.rows[0].count === 4;
  }, 'four runs complete across two engines');
  assert.ok(overlapAcrossPools, 'Independent pools should execute concurrently');
  const operations = await db.query("SELECT operation_id,finished_at FROM workspace_run_operations");
  assert.equal(operations.rowCount, 4, 'Each accepted run executes exactly once');
  assert.ok(operations.rows.every(row => row.finished_at));
  assert.equal(new Set(operations.rows.map(row => row.operation_id.split('-')[0])).size, 2, 'Both engine processes executed work');
  await until(async () => (await db.query("SELECT count(*)::int AS count FROM workspace_run_reservations WHERE settled_at IS NULL")).rows[0].count === 0, 'all reservations settle');
  console.log('PASS: two control-plane processes admitted exactly 3/12; two Redis-backed engines respected per-pool concurrency and completed all four accepted runs.');
} catch (error) {
  console.error(diagnostics.join('').slice(-18000));
  throw error;
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(done => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  })));
  const redis = new Redis(process.env.REDIS_URL!);
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    cursor = page[0];
    if (page[1].length) await redis.del(...page[1]);
  } while (cursor !== '0');
  await redis.quit();
  await db.end();
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
