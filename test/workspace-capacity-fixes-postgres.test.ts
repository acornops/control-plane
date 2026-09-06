import { redispatchWaitingRunAfterApproval } from '../src/controllers/run-controller-helpers.js';
import { repo } from '../src/store/repository.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import { reserveRunCapacity, acquireRunCapacity, releaseRunCapacity, renewRunCapacity, beginCapacityOperation } from '../src/store/repository-run-capacity.js';
import { runWorkspaceCapacityMaintenance } from '../src/services/workspace-capacity-maintenance.js';
import { assertExecutionActive } from '../src/services/workspace-execution-access.js';
import { applyAutomationApprovalOutcome, decideAutomationRunApproval } from '../src/store/repository-automation-approvals.js';

const id = `capacity-fixes-${randomUUID()}`;
const original = { enabled: config.WORKSPACE_CAPACITY_ENABLED, admission: config.WORKSPACE_ADMISSION_ENABLED, dispatch: config.WORKSPACE_DISPATCH_ENABLED };
const workspaces: string[] = [];
let attempt = 0;
async function workspace(workspaceId = id) {
  await db.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$1,$2)', [workspaceId, id]);
  workspaces.push(workspaceId);
}
async function reserve(pool: 'workflow' | 'agent' = 'workflow') {
  const runId = randomUUID();
  await withTransaction(c => reserveRunCapacity(c, { workspaceId: id, runId, pool }));
  return runId;
}
async function workflow(runId: string, status: string) {
  await db.query(`INSERT INTO workflow_runs(id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,status,compiled_access_scope,execution_id,executor_role,executor_snapshot,idempotency_key,attempt_number)
    VALUES($1,$2,$2,$2,$2,$2,$3,'{}',$2,'coordinator','{"role":"coordinator"}',$1,$4)`, [runId,id,status,++attempt]);
}
before(async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(config.DATABASE_URL, process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.match(new URL(config.DATABASE_URL).pathname, /test/);
  config.WORKSPACE_CAPACITY_ENABLED = true;
  config.WORKSPACE_ADMISSION_ENABLED = true;
  config.WORKSPACE_DISPATCH_ENABLED = true;
  await db.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$1)', [id,`${id}@example.test`]);
  await workspace();
  await db.query(`INSERT INTO workflow_definitions(workspace_id,id,name,status,created_by,prompt,agent_ids) VALUES($1,$1,$1,'active',$1,'x','["probe"]')`,[id]);
  await db.query(`INSERT INTO workflow_sessions(id,workspace_id,workflow_id,created_by,compiled_access_scope,workflow_snapshot) VALUES($1,$1,$1,$1,'{}','{}')`,[id]);
  await db.query(`INSERT INTO workflow_messages(id,session_id,workspace_id,workflow_id,role,content) VALUES($1,$1,$1,$1,'user','x')`,[id]);
  await db.query(`INSERT INTO workflow_executions(id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,status,workflow_snapshot) VALUES($1,$1,$1,$1,$1,$1,'running','{}')`,[id]);
});
after(async () => {
  mock.restoreAll();
  await db.query('DELETE FROM workflow_executions WHERE workspace_id=$1',[id]);
  await db.query('DELETE FROM workflow_sessions WHERE workspace_id=$1',[id]);
  await db.query('DELETE FROM workspaces WHERE id=ANY($1::text[])',[workspaces]);
  await db.query('DELETE FROM users WHERE id=$1',[id]);
  config.WORKSPACE_CAPACITY_ENABLED = original.enabled;
  config.WORKSPACE_ADMISSION_ENABLED = original.admission;
  config.WORKSPACE_DISPATCH_ENABLED = original.dispatch;
  await db.end();
});
for (const action of ['park', 'renew', 'begin'] as const) {
  test(`${action} rejects ownership expiring while waiting for the workspace lock`, async () => {
    const runId = await reserve('agent');
    const grant = await acquireRunCapacity(runId, 'owner');
    assert.equal(grant.status, 'granted');
    await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE run_id=$1",[runId]);
    const blocker = await db.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[id]);
    const pending = (action === 'park' ? releaseRunCapacity(runId,'owner',grant.generation!,'parked') : action === 'renew' ? renewRunCapacity(runId,'owner',grant.generation!) : beginCapacityOperation(runId,'owner',grant.generation!,randomUUID(),60000)).then(() => null, error => error);
    try {
      let blocked = false;
      for (let i=0;i<30;i++) {
        const waits = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces%'");
        if (waits.rowCount) { blocked = true; break; }
        await delay(10);
      }
      assert.equal(blocked,true,'production transaction is blocked before deadline');
      await delay(600);
      assert.equal((await db.query('SELECT lease_expires_at<clock_timestamp() AS expired FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0].expired,true);
    } finally { await blocker.query('COMMIT'); blocker.release(); }
    const error = await pending;
    await db.query('DELETE FROM workspace_run_reservations WHERE run_id=$1',[runId]);
    assert.equal(error?.code,'EXECUTION_AUTHORITY_LOST');
  });
}
test('approval after eleven minutes receives one fresh eligible queue interval', async () => {
  const runId = await reserve();
  await workflow(runId,'waiting_for_approval');
  await db.query("UPDATE workspace_run_reservations SET eligible_at=clock_timestamp()-INTERVAL '11 minutes',queue_expires_at=clock_timestamp()-INTERVAL '1 minute' WHERE run_id=$1",[runId]);
  const approvalId = randomUUID();
  await db.query(`INSERT INTO workflow_run_approvals(id,run_id,workspace_id,approval_kind,tool_call_id,tool_name,summary,arguments,created_at,expires_at)
    VALUES($1,$2,$3,'pre_step','gate','workflow.approval_gate','Gate','{}',clock_timestamp()-INTERVAL '11 minutes',clock_timestamp()+INTERVAL '4 minutes')`,[approvalId,runId,id]);
  const expiry = (await db.query('SELECT expires_at::text FROM workflow_run_approvals WHERE id=$1',[approvalId])).rows[0].expires_at;
  const approval = await decideAutomationRunApproval(approvalId,'approved',id);
  assert.ok(approval);
  assert.equal(approval.status,'approved');
  await applyAutomationApprovalOutcome(approval);
  const first = (await db.query('SELECT eligible_at::text,queue_expires_at::text FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0];
  await applyAutomationApprovalOutcome(approval);
  assert.deepEqual((await db.query('SELECT eligible_at::text,queue_expires_at::text FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0],first);
  assert.equal((await db.query('SELECT expires_at::text FROM workflow_run_approvals WHERE id=$1',[approvalId])).rows[0].expires_at,expiry);
  const grant = await acquireRunCapacity(runId,'approved');
  await db.query('DELETE FROM workspace_run_reservations WHERE run_id=$1',[runId]);
  assert.equal(grant.status,'granted');
});
test('admission closes new attempts but permits identical reservation replay', async () => {
  const runId = await reserve();
  config.WORKSPACE_ADMISSION_ENABLED = false;
  try {
    await withTransaction(c=>reserveRunCapacity(c,{workspaceId:id,runId,pool:'workflow'}));
    await assert.rejects(reserve(),{code:'WORKSPACE_ADMISSION_PAUSED',status:503});
  } finally { config.WORKSPACE_ADMISSION_ENABLED = true; await db.query('DELETE FROM workspace_run_reservations WHERE run_id=$1',[runId]); }
});
test('dispatch closes queued and parked acquisition while allowing existing lease renewal', async () => {
  const runId = await reserve();
  const grant = await acquireRunCapacity(runId,'owner');
  config.WORKSPACE_DISPATCH_ENABLED = false;
  try {
    await renewRunCapacity(runId,'owner',grant.generation!);
    assert.equal((await acquireRunCapacity(runId,'owner')).status,'granted');
    await releaseRunCapacity(runId,'owner',grant.generation!,'parked');
    assert.equal((await acquireRunCapacity(runId,'new-owner')).status,'wait');
  } finally { config.WORKSPACE_DISPATCH_ENABLED = true; await db.query('DELETE FROM workspace_run_reservations WHERE run_id=$1',[runId]); }
});
test('chat approval resume rebases the same reservation once before dispatch', async () => {
  const runId = await reserve('agent');
  await db.query(`INSERT INTO targets(id,workspace_id,target_type,name,status,created_at,updated_at) VALUES($1,$1,'kubernetes','Test','online',clock_timestamp(),clock_timestamp())`,[id]);
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at) VALUES($1,$1,$1,$1,'Test','active',clock_timestamp(),clock_timestamp())`,[id]);
  await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status) VALUES($1,$2,$2,$2,$2,'waiting_for_approval')`,[runId,id]);
  await db.query("UPDATE workspace_run_reservations SET queue_expires_at=clock_timestamp()-INTERVAL '1 minute' WHERE run_id=$1",[runId]);
  const run = await repo.getRun(runId);
  assert.ok(run);
  const sent: string[] = [];
  const stub = mock.method(globalThis,'fetch',async()=>{sent.push(runId);return new Response('{}',{status:200});});
  try {
    redispatchWaitingRunAfterApproval(run);
    for(let i=0;i<50 && !sent.length;i++) await delay(10);
    assert.equal(sent.length,1);
    const first = (await db.query('SELECT queue_expires_at::text FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0];
    redispatchWaitingRunAfterApproval(run);
    await delay(30);
    assert.deepEqual((await db.query('SELECT queue_expires_at::text FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0],first);
    assert.equal(sent.length,1);
    assert.equal((await acquireRunCapacity(runId,'chat-worker')).status,'granted');
  } finally {
    stub.mock.restore();
    await db.query('DELETE FROM runs WHERE id=$1',[runId]);
    await db.query('DELETE FROM workspace_run_reservations WHERE run_id=$1',[runId]);
  }
});
test('suspension cancels a parked coordinator without an EE callback and completes microsecond holds beyond the first batch', async () => {
  const runId = await reserve();
  await workflow(runId,'running');
  const grant = await acquireRunCapacity(runId,'parked');
  await releaseRunCapacity(runId,'parked',grant.generation!,'parked');
  await db.query("INSERT INTO workflow_dependency_continuations(run_id,generation,state) VALUES($1,$2,'{}')",[runId,grant.generation]);
  for (let i=0;i<51;i++) await workspace(`${id}-${i}`);
  await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=clock_timestamp() WHERE id=ANY($1::text[])",[workspaces]);
  await db.query("UPDATE workspace_lifecycle_outbox SET requested_at=date_trunc('milliseconds',requested_at)+INTERVAL '999 microseconds' WHERE workspace_id=ANY($1::text[])",[workspaces]);
  config.WORKSPACE_DISPATCH_ENABLED = false;
  const stub = mock.method(globalThis,'fetch',async()=>new Response('no live task',{status:404}));
  try {
    await runWorkspaceCapacityMaintenance();
    await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id=ANY($1::text[])",[workspaces]);
    await runWorkspaceCapacityMaintenance();
    await runWorkspaceCapacityMaintenance();
    assert.equal((await db.query('SELECT count(*)::int AS pending FROM workspace_lifecycle_outbox WHERE workspace_id=ANY($1::text[]) AND completed_at IS NULL',[workspaces])).rows[0].pending,0);
    const state = (await db.query('SELECT w.status,r.state,r.settled_at FROM workflow_runs w JOIN workspace_run_reservations r ON r.run_id=w.id WHERE w.id=$1',[runId])).rows[0];
    assert.equal(state.status,'cancelled');
    assert.equal(state.state,'settled');
    assert.ok(state.settled_at);
    await assert.rejects(assertExecutionActive(runId),{code:'RUN_CANCELLED_BY_SUSPENSION'});
  } finally { stub.mock.restore(); config.WORKSPACE_DISPATCH_ENABLED = true; }
});

test('suspension retains uncertain operation capacity until its deadline without an EE callback',async()=>{
  const runId=await reserve(); await workflow(runId,'running');
  const grant=await acquireRunCapacity(runId,'uncertain-owner');
  assert.equal(grant.status,'granted');
  await beginCapacityOperation(runId,'uncertain-owner',grant.generation!,randomUUID(),60000);
  await db.query("UPDATE workspace_run_reservations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1",[runId]);
  await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=clock_timestamp() WHERE id=$1",[id]);
  config.WORKSPACE_DISPATCH_ENABLED=false;
  const stub=mock.method(globalThis,'fetch',async()=>new Response('gone',{status:404}));
  try {
    await runWorkspaceCapacityMaintenance();
    let row=(await db.query('SELECT state,settled_at,executing_until FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0];
    assert.equal(row.settled_at,null); assert.ok(row.executing_until);
    await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id=$1",[id]);
    await runWorkspaceCapacityMaintenance();
    assert.equal((await db.query('SELECT settled_at FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0].settled_at,null);
    await db.query("UPDATE workspace_run_operations SET deadline=clock_timestamp()-INTERVAL '1 second' WHERE run_id=$1",[runId]);
    await runWorkspaceCapacityMaintenance();
    row=(await db.query('SELECT state,settled_at,executing_until FROM workspace_run_reservations WHERE run_id=$1',[runId])).rows[0];
    assert.equal(row.state,'settled'); assert.ok(row.settled_at); assert.equal(row.executing_until,null);
  } finally { stub.mock.restore(); config.WORKSPACE_DISPATCH_ENABLED=true; }
});
test('completing an older hold cannot complete or replace a newer suspension cutoff', async () => {
  const runId = await reserve();
  await workflow(runId,'running');
  await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=clock_timestamp() WHERE id=$1",[id]);
  const oldCutoff = (await db.query('SELECT requested_at::text FROM workspace_lifecycle_outbox WHERE workspace_id=$1',[id])).rows[0].requested_at;
  let newCutoff: string | undefined;
  config.WORKSPACE_DISPATCH_ENABLED = false;
  const stub = mock.method(globalThis,'fetch',async()=>{
    if(!newCutoff) {
      await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id=$1",[id]);
      await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=clock_timestamp() WHERE id=$1",[id]);
      newCutoff = (await db.query('SELECT requested_at::text FROM workspace_lifecycle_outbox WHERE workspace_id=$1',[id])).rows[0].requested_at;
    }
    return new Response('{}',{status:200});
  });
  try {
    await runWorkspaceCapacityMaintenance();
    const pending = (await db.query('SELECT requested_at::text,completed_at FROM workspace_lifecycle_outbox WHERE workspace_id=$1',[id])).rows[0];
    assert.ok(newCutoff);
    assert.notEqual(newCutoff,oldCutoff);
    assert.equal(pending.requested_at,newCutoff);
    assert.equal(pending.completed_at,null);
    await runWorkspaceCapacityMaintenance();
    const completed = (await db.query('SELECT requested_at::text,completed_at FROM workspace_lifecycle_outbox WHERE workspace_id=$1',[id])).rows[0];
    assert.equal(completed.requested_at,newCutoff);
    assert.ok(completed.completed_at);
  } finally {
    stub.mock.restore(); config.WORKSPACE_DISPATCH_ENABLED = true;
    await db.query("UPDATE workspaces SET lifecycle_status='active',suspended_at=NULL WHERE id=$1",[id]);
  }
});
test('execution access compares microsecond admission against the exact suspension cutoff',async()=>{
  const runId=await reserve(); await workflow(runId,'queued');
  await db.query("UPDATE workspace_lifecycle_outbox SET requested_at='2026-01-01 00:00:00.123456+00' WHERE workspace_id=$1",[id]);
  await db.query("UPDATE workspace_run_reservations SET created_at='2026-01-01 00:00:00.123457+00' WHERE run_id=$1",[runId]);
  await assertExecutionActive(runId);
  await db.query("UPDATE workspace_run_reservations SET created_at='2026-01-01 00:00:00.123455+00' WHERE run_id=$1",[runId]);
  await assert.rejects(assertExecutionActive(runId),{code:'RUN_CANCELLED_BY_SUSPENSION'});
});

test('maintenance cancels pre-suspension admissions but retains post-restore work despite request clock skew', async () => {
  const oldRun = await reserve(); await workflow(oldRun, 'queued');
  await db.query("UPDATE workflow_runs SET requested_at=clock_timestamp()+INTERVAL '1 minute' WHERE id=$1", [oldRun]);
  await db.query("UPDATE workspaces SET lifecycle_status='suspended' WHERE id=$1", [id]);
  await db.query("UPDATE workspaces SET lifecycle_status='active' WHERE id=$1", [id]);
  const newRun = await reserve(); await workflow(newRun, 'queued');
  await db.query("UPDATE workflow_runs SET requested_at=clock_timestamp()-INTERVAL '1 minute' WHERE id=$1", [newRun]);
  config.WORKSPACE_DISPATCH_ENABLED = false;
  config.WORKSPACE_CAPACITY_ENABLED = false;
  const fetchStub = mock.method(globalThis, 'fetch', async () => new Response('{}'));
  try {
    await runWorkspaceCapacityMaintenance();
    assert.equal((await db.query('SELECT status FROM workflow_runs WHERE id=$1', [oldRun])).rows[0].status, 'cancelled');
    assert.equal((await db.query('SELECT status FROM workflow_runs WHERE id=$1', [newRun])).rows[0].status, 'queued');
  } finally {
    fetchStub.mock.restore();
    config.WORKSPACE_DISPATCH_ENABLED = true;
    config.WORKSPACE_CAPACITY_ENABLED = true;
  }
});
