import assert from 'node:assert/strict';
import { after, afterEach, test, mock } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { withTransaction } from '../src/store/repository-transaction.js';
import { resumeCapacityAfterApproval } from '../src/store/repository-capacity-approval-resume.js';
import { runConversationDispatchTick } from '../src/services/conversation-dispatch-worker.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { createDelegatedWorkflowRun } from '../src/store/repository-workflow-run-delegations.js';
import { coordinatedRoot, delegationInput } from './helpers/workflow-delegation-postgres-fixtures.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

after(closeAutomationDatabaseFixtures);
afterEach(() => mock.restoreAll());
test('approval resume remains durably dispatchable after reopening the dispatch gate', async () => {
  await resetAutomationDatabaseFixtures();
  await db.query(`INSERT INTO sessions(id,workspace_id,target_id,created_by,title,status,created_at,updated_at)
    VALUES('resume-session','workspace-1','cluster-1','user-1','Resume','open',NOW(),NOW())`);
  await db.query(`INSERT INTO runs(id,workspace_id,target_id,session_id,message_id,status,requested_at)
    VALUES('resume-run','workspace-1','cluster-1','resume-session','resume-message','waiting_for_approval',NOW())`);
  const oldDispatch = config.WORKSPACE_DISPATCH_ENABLED;
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 202 }); });
  try {
    config.WORKSPACE_DISPATCH_ENABLED = false;
    assert.equal(await withTransaction(client => resumeCapacityAfterApproval(client, 'resume-run', 'runs', 'dispatching')), true);
    await runConversationDispatchTick();
    assert.equal(calls, 0);
    assert.equal((await db.query("SELECT status FROM automation_dispatch_outbox WHERE run_id='resume-run'")).rows[0].status, 'pending');
    config.WORKSPACE_DISPATCH_ENABLED = true;
    await runConversationDispatchTick();
    assert.equal(calls, 1);
    assert.equal((await db.query("SELECT status FROM automation_dispatch_outbox WHERE run_id='resume-run'")).rows[0].status, 'delivered');
    assert.equal(await withTransaction(client => resumeCapacityAfterApproval(client, 'resume-run', 'runs', 'dispatching')), false);
    await runConversationDispatchTick();
    assert.equal(calls, 1);
  } finally { config.WORKSPACE_DISPATCH_ENABLED = oldDispatch; }
});

test('workflow delivery acknowledgement leaves execution queued until an engine start event', async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  const mode = config.AUTOMATION_RUNTIME_MODE;
  try {
    config.AUTOMATION_RUNTIME_MODE = 'on';
    const setup = await coordinatedRoot();
    const child = await createDelegatedWorkflowRun(delegationInput(setup, 'dispatch-capacity'));
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 202 }));
    assert.equal(await runAutomationOutboxTick(), 1);
    const row = (await db.query('SELECT status,started_at FROM workflow_runs WHERE id=$1', [child.run.id])).rows[0];
    assert.equal(row.status, 'dispatching');
    assert.equal(row.started_at, null);
  } finally { config.AUTOMATION_RUNTIME_MODE = mode; }
});

test('safe drain rejection defers workflow delivery without exhausting attempts', async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  const mode = config.AUTOMATION_RUNTIME_MODE;
  const timeout = config.EXECUTION_ENGINE_TIMEOUT_MS;
  try {
    config.AUTOMATION_RUNTIME_MODE = 'on';
    config.EXECUTION_ENGINE_TIMEOUT_MS = 20;
    const setup = await coordinatedRoot();
    const child = await createDelegatedWorkflowRun(delegationInput(setup, 'drain-dispatch'));
    await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [child.run.id]);
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: {
      code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started'
    } }), { status: 503 }));
    await runAutomationOutboxTick();
    const row = (await db.query('SELECT status,attempt_count FROM automation_dispatch_outbox WHERE run_id=$1', [child.run.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 2);
    assert.equal((await db.query('SELECT status FROM workflow_runs WHERE id=$1', [child.run.id])).rows[0].status, 'queued');
  } finally { config.AUTOMATION_RUNTIME_MODE = mode; config.EXECUTION_ENGINE_TIMEOUT_MS = timeout; }
});
