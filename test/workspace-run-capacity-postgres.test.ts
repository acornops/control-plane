import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import {
  reserveRunCapacity, acquireRunCapacity, renewRunCapacity, releaseRunCapacity,
  beginCapacityOperation, finishCapacityOperation, settleRunCapacity
} from '../src/store/repository-run-capacity.js';

const workspaceId = `capacity-test-${randomUUID()}`;
const actorId = `capacity-test-${randomUUID()}`;
const originalPlans = config.WORKSPACE_PLANS;
const originalEnabled = config.WORKSPACE_CAPACITY_ENABLED;
before(async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.equal(config.DATABASE_URL, process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.match(new URL(config.DATABASE_URL).pathname, /test/);
  config.WORKSPACE_CAPACITY_ENABLED = true;
  const plan = originalPlans.plans[0];
  config.WORKSPACE_PLANS = { defaultPlanKey: plan.key, plans: [{ ...plan, executionLimits: {
    chat: { maxConcurrentRuns: 1, maxOutstandingRuns: 2 },
    agent: { maxConcurrentRuns: 1, maxOutstandingRuns: 2 },
    workflow: { maxConcurrentRuns: 1, maxOutstandingRuns: 4 },
    autoTriage: { maxConcurrentRuns: 1, maxOutstandingRuns: 2 },
    insights: { maxConcurrentRuns: 1, maxOutstandingRuns: 2 }
  } }] };
  await db.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)', [actorId, `${actorId}@example.test`, 'Capacity test']);
  await db.query('INSERT INTO workspaces(id,name,created_by,plan_key) VALUES($1,$2,$3,$4)', [workspaceId, 'Capacity test', actorId, plan.key]);
});
after(async () => {
  await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
  await db.query('DELETE FROM users WHERE id=$1', [actorId]);
  config.WORKSPACE_PLANS = originalPlans;
  config.WORKSPACE_CAPACITY_ENABLED = originalEnabled;
  await db.end();
});

test('independent connections cannot over-admit a pool, while another pool retains capacity', async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
    withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: randomUUID(), pool: 'chat' }))));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 2);
  for (const attempt of attempts) if (attempt.status === 'rejected') assert.equal(attempt.reason.code, 'WORKSPACE_OUTSTANDING_RUN_LIMIT');
  const id = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: id, pool: 'agent' }));
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: id, pool: 'agent' }));
  await assert.rejects(withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: id, pool: 'insights' })), /identity/i);
});

test('grant races have one winner and parked parents release execution, not outstanding', async () => {
  const ids = [randomUUID(), randomUUID()];
  for (const runId of ids) await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId, pool: 'workflow' }));
  const grants = await Promise.all(ids.map((id) => acquireRunCapacity(id, 'engine-a')));
  assert.equal(grants.filter((grant) => grant.status === 'granted').length, 1);
  const first = grants.findIndex((grant) => grant.status === 'granted');
  const grant = grants[first];
  await releaseRunCapacity(ids[first], 'engine-a', grant.generation!, 'parked');
  assert.equal((await acquireRunCapacity(ids[1 - first], 'engine-b')).status, 'granted');
  const outstanding = await db.query('SELECT count(*)::int AS count FROM workspace_run_reservations WHERE workspace_id=$1 AND pool=$2 AND settled_at IS NULL', [workspaceId, 'workflow']);
  assert.equal(outstanding.rows[0].count, 2);
});

test('expired ownership fences new operations but does not free an in-flight operation', async () => {
  const runId = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId, pool: 'insights' }));
  const grant = await acquireRunCapacity(runId, 'engine-a');
  assert.equal(grant.status, 'granted');
  const operationId = randomUUID();
  await beginCapacityOperation(runId, 'engine-a', grant.generation!, operationId, 60000);
  await db.query("UPDATE workspace_run_reservations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [runId]);
  await assert.rejects(renewRunCapacity(runId, 'engine-a', grant.generation!), /authority/i);
  await assert.rejects(beginCapacityOperation(runId, 'engine-a', grant.generation!, randomUUID(), 60000), /authority/i);
  assert.equal((await acquireRunCapacity(runId, 'engine-b')).status, 'blocked');
  await settleRunCapacity(runId);
  assert.equal((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1', [runId])).rows[0].settled_at, null);
  await finishCapacityOperation(runId, 'engine-a', grant.generation!, operationId);
  await settleRunCapacity(runId);
  await settleRunCapacity(runId);
  assert.ok((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1', [runId])).rows[0].settled_at);
});

test('repeated settlement retains a live worker lease until explicit release', async () => {
  const runId = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId, pool: 'autoTriage' }));
  const grant = await acquireRunCapacity(runId, 'engine-c');
  await settleRunCapacity(runId);
  await settleRunCapacity(runId);
  assert.equal((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1', [runId])).rows[0].settled_at, null);
  await releaseRunCapacity(runId, 'engine-c', grant.generation!);
  await settleRunCapacity(runId);
  await releaseRunCapacity(runId, 'engine-c', grant.generation!, 'parked');
  assert.equal((await db.query('SELECT state FROM workspace_run_reservations WHERE run_id=$1', [runId])).rows[0].state, 'settled');
});

test('rapid restore does not revive attempts admitted before suspension', async () => {
  const oldRun = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: oldRun, pool: 'autoTriage' }));
  await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=NOW() WHERE id=$1", [workspaceId]);
  await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id=$1", [workspaceId]);
  assert.equal((await acquireRunCapacity(oldRun, 'engine-new')).status, 'blocked');
  await settleRunCapacity(oldRun);
  const newRun = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId: newRun, pool: 'autoTriage' }));
  assert.equal((await acquireRunCapacity(newRun, 'engine-new')).status, 'granted');
});

test('an expired worker cannot park an attempt to make it executable again', async () => {
  const runId = randomUUID();
  await withTransaction((client) => reserveRunCapacity(client, { workspaceId, runId, pool: 'agent' }));
  const grant = await acquireRunCapacity(runId, 'expired-worker');
  await db.query("UPDATE workspace_run_reservations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [runId]);
  await assert.rejects(releaseRunCapacity(runId, 'expired-worker', grant.generation!, 'parked'), /authority/i);
  assert.equal((await acquireRunCapacity(runId, 'replacement')).status, 'blocked');
});
