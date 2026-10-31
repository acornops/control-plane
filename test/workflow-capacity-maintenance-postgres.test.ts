import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { runWorkspaceCapacityMaintenance } from '../src/services/workspace-capacity-maintenance.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { resumeWorkflowExecution } from '../src/services/workflow-state-machine.js';
import { acquireRunCapacity, beginCapacityOperation, releaseRunCapacity } from '../src/store/repository-run-capacity.js';
import { createDelegatedWorkflowRun } from '../src/store/repository-workflow-run-delegations.js';
import { coordinatedRoot, delegationInput } from './helpers/workflow-delegation-postgres-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

const original = { capacity: config.WORKSPACE_CAPACITY_ENABLED, dispatch: config.WORKSPACE_DISPATCH_ENABLED };
beforeEach(async () => {
  config.WORKSPACE_CAPACITY_ENABLED = true;
  config.WORKSPACE_DISPATCH_ENABLED = false;
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(() => {
  mock.restoreAll();
  config.WORKSPACE_CAPACITY_ENABLED = original.capacity;
  config.WORKSPACE_DISPATCH_ENABLED = original.dispatch;
});
after(closeAutomationDatabaseFixtures);

async function queuedRoot() {
  const { parent } = await coordinatedRoot();
  await db.query("UPDATE workflow_runs SET status='queued' WHERE id=$1", [parent.id]);
  await db.query("UPDATE workflow_executions SET status='queued' WHERE id=$1", [parent.executionId]);
  await db.query("UPDATE automation_dispatch_outbox SET status='pending',delivered_at=NULL WHERE run_id=$1", [parent.id]);
  return parent;
}

async function expireQueue(runId: string) {
  await db.query("UPDATE workspace_run_reservations SET queue_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1", [runId]);
}

async function state(runId: string) {
  return (await db.query(`SELECT r.status AS run_status,r.error_code,r.ended_at,
    e.status AS execution_status,e.error_code AS execution_error,e.ended_at AS execution_end,
    c.state AS capacity_state,c.settled_at,o.status AS outbox_status
    FROM workflow_runs r JOIN workflow_executions e ON e.id=r.execution_id
    JOIN workspace_run_reservations c ON c.run_id=r.id
    JOIN automation_dispatch_outbox o ON o.run_id=r.id WHERE r.id=$1`, [runId])).rows[0];
}

function retrySnapshot(run: Awaited<ReturnType<typeof queuedRoot>>) {
  return { workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowSessionId: run.workflowSessionId, messageId: run.messageId,
    executorRole: run.executorRole, compiledAccessScope: run.compiledAccessScope, prompt: run.prompt };
}

for (const capacity of [false, true]) {
  for (const acknowledged of [false, true]) {
    test(`queue expiry updates the workflow and closes pending delivery (capacity=${capacity}, acknowledged=${acknowledged})`, async () => {
      config.WORKSPACE_CAPACITY_ENABLED = capacity;
      const run = await queuedRoot();
      if (acknowledged) {
        await db.query("UPDATE workflow_runs SET status='dispatching' WHERE id=$1", [run.id]);
        await db.query("UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1", [run.id]);
      }
      await expireQueue(run.id);
      await runWorkspaceCapacityMaintenance();
      const result = await state(run.id);
      assert.equal(result.run_status, 'failed');
      assert.equal(result.execution_status, 'failed');
      assert.equal(result.execution_error, 'EXECUTION_AUTHORITY_LOST');
      assert.ok(result.execution_end);
      assert.deepEqual(result.execution_end, result.ended_at);
      assert.equal(result.capacity_state, 'settled');
      assert.ok(result.settled_at);
      assert.equal(result.outbox_status, acknowledged ? 'delivered' : 'cancelled');
      await runWorkspaceCapacityMaintenance();
      assert.deepEqual(await state(run.id), result);
      const resumed = await resumeWorkflowExecution(run.executionId, 'user-1', retrySnapshot(run));
      assert.equal(resumed.status, 'queued');
      assert.notEqual(resumed.runId, run.id);
      await runWorkspaceCapacityMaintenance();
      assert.equal((await state(resumed.runId)).execution_status, 'queued');
      assert.equal((await state(resumed.runId)).outbox_status, 'pending');
    });
  }
}

test('aggregate failure rolls back expiry and leaves capacity available for a later sweep', async () => {
  const run = await queuedRoot();
  await expireQueue(run.id);
  await db.query(`CREATE FUNCTION reject_capacity_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'injected aggregate failure'; END IF; RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER reject_capacity_aggregate BEFORE UPDATE ON workflow_executions FOR EACH ROW EXECUTE FUNCTION reject_capacity_aggregate()');
  try {
    await assert.rejects(runWorkspaceCapacityMaintenance(), /injected aggregate failure/);
    const result = await state(run.id);
    assert.equal(result.run_status, 'queued');
    assert.equal(result.execution_status, 'queued');
    assert.equal(result.error_code, null);
    assert.equal(result.settled_at, null);
    assert.equal(result.outbox_status, 'pending');
  } finally {
    await db.query('DROP TRIGGER reject_capacity_aggregate ON workflow_executions');
    await db.query('DROP FUNCTION reject_capacity_aggregate()');
  }
  await runWorkspaceCapacityMaintenance();
  assert.equal((await state(run.id)).execution_status, 'failed');
});

test('maintenance repairs historical settled failures without redispatch', async () => {
  const run = await queuedRoot();
  await db.query(`UPDATE workflow_runs SET status='failed',error_code='EXECUTION_AUTHORITY_LOST',
    error_message='Historical expiry',ended_at=clock_timestamp()-INTERVAL '1 day' WHERE id=$1`, [run.id]);
  await db.query("UPDATE workspace_run_reservations SET state='settled',settled_at=clock_timestamp() WHERE run_id=$1", [run.id]);
  mock.method(globalThis, 'fetch', async () => { assert.fail('Repair must never dispatch expired work'); });
  await runWorkspaceCapacityMaintenance();
  const result = await state(run.id);
  assert.equal(result.execution_status, 'failed');
  assert.equal(result.execution_error, 'EXECUTION_AUTHORITY_LOST');
  assert.deepEqual(result.execution_end, result.ended_at);
  assert.equal(result.outbox_status, 'cancelled');
  config.WORKSPACE_DISPATCH_ENABLED = true;
  assert.equal(await runAutomationOutboxTick(), 0);
});

test('reconciliation preserves an existing terminal outcome', async () => {
  const run = await queuedRoot();
  await db.query("UPDATE workflow_executions SET status='completed',ended_at=clock_timestamp() WHERE id=$1", [run.executionId]);
  await db.query("UPDATE workflow_runs SET status='failed',error_code='EXECUTION_AUTHORITY_LOST',ended_at=clock_timestamp() WHERE id=$1", [run.id]);
  await runWorkspaceCapacityMaintenance();
  assert.equal((await state(run.id)).execution_status, 'completed');
});

test('expiry of a child does not fail its running coordinator', async () => {
  const setup = await coordinatedRoot();
  const { run } = await createDelegatedWorkflowRun(delegationInput(setup, 'capacity-expiry'));
  await expireQueue(run.id);
  await runWorkspaceCapacityMaintenance();
  const result = await state(run.id);
  assert.equal(result.run_status, 'failed');
  assert.equal(result.execution_status, 'running');
  assert.equal(result.execution_error, null);
  assert.equal(result.outbox_status, 'cancelled');
});

test('a running or approval-waiting run is not failed by its old queue deadline', async () => {
  for (const status of ['running', 'waiting_for_approval']) {
    const run = await queuedRoot();
    await db.query('UPDATE workflow_runs SET status=$2 WHERE id=$1', [run.id, status]);
    await db.query('UPDATE workflow_executions SET status=$2 WHERE id=$1', [run.executionId, status]);
    await expireQueue(run.id);
    await runWorkspaceCapacityMaintenance();
    const result = await state(run.id);
    assert.equal(result.run_status, status);
    assert.equal(result.execution_status, status);
    assert.equal(result.settled_at, null);
  }
});

test('expired execution lease updates its workflow summary', async () => {
  const { parent } = await coordinatedRoot();
  config.WORKSPACE_DISPATCH_ENABLED = true;
  assert.equal((await acquireRunCapacity(parent.id, 'maintenance-test')).status, 'granted');
  await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1", [parent.id]);
  await runWorkspaceCapacityMaintenance();
  assert.equal((await state(parent.id)).execution_status, 'failed');
});

test('suspension cancels a parked coordinator and its workflow summary without an engine callback', async () => {
  const { parent } = await coordinatedRoot();
  config.WORKSPACE_DISPATCH_ENABLED = true;
  const grant = await acquireRunCapacity(parent.id, 'maintenance-test');
  await releaseRunCapacity(parent.id, 'maintenance-test', grant.generation!, 'parked');
  config.WORKSPACE_DISPATCH_ENABLED = false;
  await db.query("UPDATE workspaces SET lifecycle_status='suspended' WHERE id='workspace-1'");
  mock.method(globalThis, 'fetch', async () => new Response('No live task', { status: 404 }));
  await runWorkspaceCapacityMaintenance();
  const result = await state(parent.id);
  assert.equal(result.run_status, 'cancelled');
  assert.equal(result.execution_status, 'cancelled');
  assert.equal(result.execution_error, 'WORKSPACE_SUSPENDED');
  assert.ok(result.execution_end);
});

test('maintenance does not block or fail a run whose start callback is committing', async () => {
  const run = await queuedRoot();
  await expireQueue(run.id);
  const writer = await db.connect();
  await writer.query('BEGIN');
  await writer.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [run.id]);
  await writer.query("UPDATE workflow_executions SET status='running' WHERE id=$1", [run.executionId]);
  const maintenance = runWorkspaceCapacityMaintenance();
  try {
    assert.equal(await Promise.race([maintenance.then(() => true), delay(1000).then(() => false)]), true);
  } finally {
    await writer.query('COMMIT');
    writer.release();
    await maintenance;
  }
  await runWorkspaceCapacityMaintenance();
  const result = await state(run.id);
  assert.equal(result.run_status, 'running');
  assert.equal(result.execution_status, 'running');
  assert.equal(result.capacity_state, 'queued');
  assert.equal(result.settled_at, null);
});

test('expiry rechecks a renewed lease after waiting for the workspace lock', async () => {
  const { parent } = await coordinatedRoot();
  config.WORKSPACE_DISPATCH_ENABLED = true;
  await acquireRunCapacity(parent.id, 'maintenance-test');
  await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1", [parent.id]);
  config.WORKSPACE_DISPATCH_ENABLED = false;
  const writer = await db.connect();
  await writer.query('BEGIN');
  await writer.query("SELECT id FROM workspaces WHERE id='workspace-1' FOR UPDATE");
  const maintenance = runWorkspaceCapacityMaintenance();
  try {
    let blocked = false;
    for (let i = 0; i < 100; i += 1) {
      const waits = await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces%'
        AND pid<>pg_backend_pid()`);
      if (waits.rowCount) { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true);
    await writer.query(`UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()+INTERVAL '1 minute',
      executing_until=clock_timestamp()+INTERVAL '1 minute' WHERE run_id=$1`, [parent.id]);
  } finally {
    await writer.query('COMMIT');
    writer.release();
    await maintenance;
  }
  const result = await state(parent.id);
  assert.equal(result.run_status, 'running');
  assert.equal(result.execution_status, 'running');
  assert.equal(result.capacity_state, 'executing');
  assert.equal(result.settled_at, null);
});

test('historical repair is bounded and skips locked summaries so other workflows progress', async () => {
  const run = await queuedRoot();
  await db.query(`INSERT INTO workflow_executions(id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,status,workflow_snapshot)
    SELECT 'history-'||n,workspace_id,workflow_id,workflow_session_id,message_id,created_by,'queued',workflow_snapshot
    FROM workflow_executions CROSS JOIN generate_series(1,202) n WHERE id=$1`, [run.executionId]);
  await db.query(`INSERT INTO workflow_runs(id,execution_id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,
    status,compiled_access_scope,executor_role,executor_snapshot,idempotency_key,error_code,ended_at)
    SELECT 'historical-run-'||n,'history-'||n,workspace_id,workflow_id,workflow_session_id,message_id,created_by,
    'failed',compiled_access_scope,executor_role,executor_snapshot,'historical-run-'||n,'EXECUTION_AUTHORITY_LOST',clock_timestamp()
    FROM workflow_runs CROSS JOIN generate_series(1,202) n WHERE id=$1`, [run.id]);
  const writer = await db.connect();
  await writer.query('BEGIN');
  await writer.query("SELECT id FROM workflow_executions WHERE id='history-1' FOR UPDATE");
  try {
    await runWorkspaceCapacityMaintenance();
    const counts = await db.query("SELECT status,count(*)::int AS count FROM workflow_executions WHERE id LIKE 'history-%' GROUP BY status ORDER BY status");
    assert.deepEqual(counts.rows, [{ status: 'failed', count: 200 }, { status: 'queued', count: 2 }]);
  } finally {
    await writer.query('COMMIT');
    writer.release();
  }
  await runWorkspaceCapacityMaintenance();
  assert.equal((await db.query("SELECT count(*)::int AS count FROM workflow_executions WHERE id LIKE 'history-%' AND status='failed'")).rows[0].count, 202);
});

for (const historical of [false, true]) {
  test(`root termination cancels old children before retry while retaining uncertain capacity (historical=${historical})`, async () => {
    const setup = await coordinatedRoot();
    const queued = (await createDelegatedWorkflowRun(delegationInput(setup, 'old-queued-child'))).run;
    const active = (await createDelegatedWorkflowRun(delegationInput(setup, 'old-active-child'))).run;
    config.WORKSPACE_DISPATCH_ENABLED = true;
    const rootGrant = await acquireRunCapacity(setup.parent.id, 'root-owner');
    assert.equal(rootGrant.status, 'granted');
    const childGrant = await acquireRunCapacity(active.id, 'child-owner');
    assert.equal(childGrant.status, 'granted');
    await beginCapacityOperation(active.id, 'child-owner', childGrant.generation!, 'uncertain-child-operation', 60000);
    await db.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [active.id]);
    await db.query("UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=clock_timestamp() WHERE run_id=$1", [active.id]);
    await db.query(`INSERT INTO workflow_run_approvals(id,run_id,workspace_id,approval_kind,tool_call_id,tool_name,summary,expires_at)
      VALUES('old-child-approval',$1,'workspace-1','pre_step','gate','workflow.approval_gate','Old child approval',clock_timestamp()+INTERVAL '5 minutes')`, [queued.id]);
    await db.query("INSERT INTO workflow_run_continuations(run_id,approval_id,state) VALUES($1,'old-child-approval','{}')", [queued.id]);
    await db.query("INSERT INTO workflow_dependency_continuations(run_id,generation,state) VALUES($1,$2,'{}')", [setup.parent.id, rootGrant.generation]);
    if (historical) {
      await db.query("UPDATE workflow_runs SET status='failed',error_code='EXECUTION_AUTHORITY_LOST',ended_at=clock_timestamp() WHERE id=$1", [setup.parent.id]);
      await db.query("UPDATE workspace_run_reservations SET state='settled',settled_at=clock_timestamp(),executing_until=NULL WHERE run_id=$1", [setup.parent.id]);
    } else {
      await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1", [setup.parent.id]);
    }
    config.WORKSPACE_DISPATCH_ENABLED = false;
    if (historical) config.WORKSPACE_CAPACITY_ENABLED = false;
    const cancelled: string[] = [];
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      assert.ok(url.endsWith('/cancel'), 'Maintenance may cancel existing runs but must not dispatch');
      cancelled.push(url);
      return new Response('{}', { status: 200 });
    });
    await db.query(`CREATE FUNCTION reject_child_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'injected child cleanup failure'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER reject_child_cleanup BEFORE UPDATE ON workflow_executions FOR EACH ROW EXECUTE FUNCTION reject_child_cleanup()');
    try {
      await assert.rejects(runWorkspaceCapacityMaintenance(), /injected child cleanup failure/);
      assert.equal((await state(queued.id)).run_status, 'queued');
      assert.equal((await state(active.id)).run_status, 'running');
      assert.equal((await state(active.id)).capacity_state, 'executing');
      assert.equal(cancelled.length, 0);
    } finally {
      await db.query('DROP TRIGGER reject_child_cleanup ON workflow_executions');
      await db.query('DROP FUNCTION reject_child_cleanup()');
    }
    await runWorkspaceCapacityMaintenance();
    assert.equal((await state(setup.parent.id)).execution_status, 'failed');
    assert.equal((await state(queued.id)).run_status, 'cancelled');
    assert.equal((await state(queued.id)).outbox_status, 'cancelled');
    assert.equal((await state(active.id)).run_status, 'cancelled');
    assert.equal((await state(active.id)).outbox_status, 'delivered');
    assert.equal((await db.query("SELECT status FROM workflow_run_approvals WHERE id='old-child-approval'")).rows[0].status, 'expired');
    assert.equal((await db.query('SELECT 1 FROM workflow_run_continuations WHERE run_id=$1', [queued.id])).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM workflow_dependency_continuations WHERE run_id=$1', [setup.parent.id])).rowCount, 0);
    assert.ok(cancelled.some((url) => url.includes(active.id)));
    assert.equal((await acquireRunCapacity(active.id, 'child-owner')).status, 'blocked');
    const reservation = (await db.query('SELECT state,executing_until,settled_at FROM workspace_run_reservations WHERE run_id=$1', [active.id])).rows[0];
    assert.equal(reservation.state, 'settling');
    assert.ok(reservation.executing_until);
    assert.equal(reservation.settled_at, null);
    const retry = await resumeWorkflowExecution(setup.parent.executionId, 'user-1', retrySnapshot(setup.parent));
    assert.equal(retry.status, 'queued');
    assert.equal((await state(queued.id)).run_status, 'cancelled');
  });
}
