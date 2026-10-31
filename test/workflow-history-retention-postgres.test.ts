import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { purgeExpiredWorkflowHistory } from '../src/store/repository-workflow-history.js';
import { coordinatedRoot } from './helpers/workflow-delegation-postgres-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

async function expiredHistory(days = 31) {
  const { parent } = await coordinatedRoot();
  await db.query(`UPDATE workflow_sessions SET created_at=NOW()-($2*INTERVAL '1 day') WHERE id=$1`, [parent.workflowSessionId, days]);
  await db.query(`UPDATE workflow_executions SET status='completed',created_at=NOW()-($2*INTERVAL '1 day'),
    ended_at=NOW()-($2*INTERVAL '1 day'),updated_at=NOW()-($2*INTERVAL '1 day') WHERE id=$1`, [parent.executionId, days]);
  await db.query(`UPDATE workflow_runs SET status='completed',ended_at=NOW()-($2*INTERVAL '1 day') WHERE id=$1`, [parent.id, days]);
  await db.query(`UPDATE workflow_messages SET created_at=NOW()-($2*INTERVAL '1 day') WHERE session_id=$1`, [parent.workflowSessionId, days]);
  await db.query(`UPDATE workspace_run_reservations SET state='settled',settled_at=NOW()-($2*INTERVAL '1 day') WHERE run_id=$1`, [parent.id, days]);
  return parent;
}

async function approval(runId: string, status = 'pending', executionStatus = 'not_started') {
  await db.query(`INSERT INTO workflow_run_approvals(id,workspace_id,run_id,approval_kind,tool_call_id,tool_name,summary,status,execution_status,expires_at)
    VALUES($1,'workspace-1',$2,'pre_step','step','test','Review',$3,$4,NOW()+INTERVAL '1 day')`, [`approval-${runId}`, runId, status, executionStatus]);
}

it('deletes old completed history and its payloads, keeping recent sessions and definitions', async () => {
  const old = await expiredHistory();
  const recent = await expiredHistory(29);
  await db.query(`INSERT INTO workflow_run_events(run_id,seq,schema_version,event_type,occurred_at,payload)
    VALUES($1,1,1,'tool_result',NOW()-INTERVAL '31 days','{"evidence":"payload"}')`, [old.id]);
  await approval(old.id, 'approved', 'succeeded');
  await db.query(`INSERT INTO generated_documents(id,workspace_id,workflow_execution_id,workflow_run_id,title,source,provenance,source_size_bytes,retention_expires_at)
    VALUES('old-document','workspace-1',$1,$2,'Evidence','{}','{}',2,NOW()-INTERVAL '1 day')`, [old.executionId, old.id]);
  assert.equal(await purgeExpiredWorkflowHistory(30), 1);
  for (const table of ['workflow_runs', 'workflow_run_events', 'workflow_run_approvals', 'generated_documents']) {
    const column = table === 'workflow_runs' ? 'id' : table === 'generated_documents' ? 'workflow_run_id' : 'run_id';
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [old.id])).rowCount, 0);
  }
  assert.equal((await db.query('SELECT 1 FROM workflow_execution_events WHERE execution_id=$1', [old.executionId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM workflow_messages WHERE session_id=$1', [old.workflowSessionId])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM automation_dispatch_outbox WHERE run_id=$1', [old.id])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM workspace_run_reservations WHERE run_id=$1', [old.id])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM workflow_sessions WHERE id=$1', [recent.workflowSessionId])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM workflow_definitions WHERE id=$1', [old.workflowId])).rowCount, 1);
  assert.equal(await purgeExpiredWorkflowHistory(30), 0);
});

for (const state of ['queued', 'dispatching', 'running', 'waiting_for_approval', 'needs_review', 'cancelling']) {
  it(`retains history when any run is ${state}, even if its aggregate is terminal`, async () => {
    const run = await expiredHistory();
    await db.query('UPDATE workflow_runs SET status=$2 WHERE id=$1', [run.id, state]);
    assert.equal(await purgeExpiredWorkflowHistory(30), 0);
  });
}

it('retains pending approvals, unknown/executing writes, live dispatch and unsettled capacity', async () => {
  for (const state of ['pending', 'executing', 'unknown', 'dispatch', 'capacity']) {
    const run = await expiredHistory();
    if (state === 'pending') await approval(run.id);
    else if (state === 'executing' || state === 'unknown') await approval(run.id, 'approved', state);
    else if (state === 'dispatch') await db.query("UPDATE automation_dispatch_outbox SET status='claimed' WHERE run_id=$1", [run.id]);
    else await db.query("UPDATE workspace_run_reservations SET state='executing',settled_at=NULL WHERE run_id=$1", [run.id]);
  }
  assert.equal(await purgeExpiredWorkflowHistory(30), 0);
});

it('keeps shared context when a session receives a new message or recent execution activity', async () => {
  const message = await expiredHistory();
  await db.query('UPDATE workflow_messages SET created_at=NOW() WHERE session_id=$1', [message.workflowSessionId]);
  const execution = await expiredHistory();
  await db.query('UPDATE workflow_executions SET updated_at=NOW() WHERE id=$1', [execution.executionId]);
  assert.equal(await purgeExpiredWorkflowHistory(30), 0);
});

it('expires failed/cancelled history and resolved pre-step approvals, but keeps unexecuted approved writes', async () => {
  for (const status of ['failed', 'cancelled']) {
    const run = await expiredHistory();
    await db.query('UPDATE workflow_executions SET status=$2 WHERE id=$1', [run.executionId, status]);
    await db.query('UPDATE workflow_runs SET status=$2 WHERE id=$1', [run.id, status]);
    await approval(run.id, 'approved');
  }
  const write = await expiredHistory();
  await approval(write.id, 'approved');
  await db.query(`UPDATE workflow_run_approvals SET approval_kind='tool_write',server_id='server',
    server_tool_name='write',requested_tool_alias='write',arguments_digest=repeat('a',64) WHERE run_id=$1`, [write.id]);
  assert.equal(await purgeExpiredWorkflowHistory(30), 2);
  assert.equal((await db.query('SELECT 1 FROM workflow_runs WHERE id=$1', [write.id])).rowCount, 1);
});

it('skips a concurrently resuming execution and still purges another eligible session', async () => {
  const resuming = await expiredHistory();
  await expiredHistory();
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE', [resuming.executionId]);
    assert.equal(await purgeExpiredWorkflowHistory(30), 1);
    await writer.query("UPDATE workflow_executions SET status='running',ended_at=NULL WHERE id=$1", [resuming.executionId]);
    await writer.query("UPDATE workflow_runs SET status='running',ended_at=NULL WHERE id=$1", [resuming.id]);
    await writer.query('COMMIT');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  assert.equal(await purgeExpiredWorkflowHistory(30), 0);
});

it('supports concurrent bounded sweeps and preserves sessions held by an append transaction', async () => {
  const held = await expiredHistory();
  await expiredHistory();
  await expiredHistory();
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM workflow_sessions WHERE id=$1 FOR KEY SHARE', [held.workflowSessionId]);
    const counts = await Promise.all([purgeExpiredWorkflowHistory(30, 1), purgeExpiredWorkflowHistory(30, 1)]);
    assert.deepEqual(counts, [1, 1]);
    assert.equal((await db.query('SELECT 1 FROM workflow_sessions WHERE id=$1', [held.workflowSessionId])).rowCount, 1);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  assert.equal(await purgeExpiredWorkflowHistory(30, 1), 1);
});
