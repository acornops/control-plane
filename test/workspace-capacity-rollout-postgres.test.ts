import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { canonicalPolicyHash } from '../src/store/repository-workspace-policy-read.js';
import { resetAutomationDatabaseFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

after(closeAutomationDatabaseFixtures);
test('rollout CLI verifies compatible replicas and backfills retained attempts before activation', async () => {
  await resetAutomationDatabaseFixtures();
  await db.query('UPDATE workspace_capacity_rollout SET active=false,catalog_hash=NULL,verified_at=NULL WHERE singleton');
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
    VALUES('rollout-session','workspace-1','cluster-1','user-1','Retained','open',NOW(),NOW())`);
  await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
    VALUES('retained-run','workspace-1','cluster-1','rollout-session','retained-message','queued',NOW())`);
  const executionLimits = Object.fromEntries(['chat', 'agent', 'workflow', 'autoTriage', 'insights'].map(pool => [pool, { maxConcurrentRuns: 1, maxOutstandingRuns: 3 }]));
  const plan = { key: 'rollout-test-v1', name: 'Rollout test', quotas: { members: 100, kubernetesClusters: 30, virtualMachines: 30 }, executionLimits };
  await db.query('UPDATE workspaces SET plan_key=$1', [plan.key]);
  const catalogue = { defaultPlanKey: plan.key, plans: [plan] };
  const hash = canonicalPolicyHash({ defaultPlanKey: plan.key, plans: [{ key: plan.key, quotas: plan.quotas, executionLimits }] });
  let mode = false;
  let version = 0;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ capacity_contract_version: version, capacity_enabled: mode,
      admission_enabled: false, dispatch_enabled: false, workspace_catalog_hash: hash }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'acornops-rollout-'));
  const peers = join(directory, 'peers.json');
  await writeFile(peers, JSON.stringify(['control-plane', 'execution-engine', 'llm-gateway'].map(service => ({ service, url: `http://127.0.0.1:${address.port}` }))));
  const cli = (command: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const entry = process.env.CONTROL_PLANE_ROLLOUT_TEST_COMPILED === 'true'
      ? ['dist/scripts/workspace-capacity-rollout.js'] : ['--import', 'tsx', 'src/scripts/workspace-capacity-rollout.ts'];
    const child = spawn(process.execPath, [...entry, command, peers, '--require-finite'], {
      env: { ...process.env, DATABASE_URL: config.DATABASE_URL, WORKSPACE_PLANS_CONFIG_JSON: JSON.stringify(catalogue),
        WORKSPACE_ADMISSION_ENABLED: 'false', WORKSPACE_DISPATCH_ENABLED: 'false', WORKSPACE_CAPACITY_ENABLED: String(mode) }
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
  try {
    const incompatible = await cli('prepare');
    assert.equal(incompatible.code, 1, incompatible.output);
    assert.match(incompatible.output, /Incompatible peer/);
    version = 1;
    const prepared = await cli('prepare');
    assert.equal(prepared.code, 0, prepared.output);
    const reservation = await db.query("SELECT pool,state FROM workspace_run_reservations WHERE run_id='retained-run'");
    assert.deepEqual(reservation.rows, [{ pool: 'chat', state: 'queued' }]);
    assert.equal((await db.query("SELECT status FROM automation_dispatch_outbox WHERE run_id='retained-run'")).rows[0].status, 'pending');
    assert.equal((await db.query('SELECT verified_at FROM workspace_capacity_rollout')).rows[0].verified_at, null);
    mode = true;
    const verified = await cli('verify');
    assert.equal(verified.code, 0, verified.output);
    assert.ok((await db.query('SELECT verified_at FROM workspace_capacity_rollout')).rows[0].verified_at);
    await db.query("UPDATE runs SET status='running' WHERE id='retained-run'");
    mode = false;
    const active = await cli('deactivate');
    assert.equal(active.code, 1, active.output);
    assert.match(active.output, /remain/);
    await db.query("UPDATE runs SET status='cancelled' WHERE id='retained-run'");
    assert.equal((await cli('deactivate')).code, 0);
  } finally {
    await db.query('UPDATE workspace_capacity_rollout SET active=false,catalog_hash=NULL,verified_at=NULL WHERE singleton');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
