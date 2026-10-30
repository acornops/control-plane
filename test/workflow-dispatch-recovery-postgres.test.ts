import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { commitRun } from '../src/controllers/internal-execution-controller.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { cancelWorkflowExecutionGraph } from '../src/services/workflow-execution-cancellation.js';
import { createDelegatedWorkflowRun } from '../src/store/repository-workflow-run-delegations.js';
import { recomputeWorkflowExecutionStatusForRun } from '../src/store/repository-workflow-execution-aggregate.js';
import { coordinatedRoot, delegationInput } from './helpers/workflow-delegation-postgres-fixtures.js';
import { callController, createRequest, restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

const originalMode = config.AUTOMATION_RUNTIME_MODE;
beforeEach(async () => {
  config.AUTOMATION_RUNTIME_MODE = 'on';
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(() => {
  config.AUTOMATION_RUNTIME_MODE = originalMode;
  mock.restoreAll();
  restoreControllerRegressionState();
});
after(closeAutomationDatabaseFixtures);

test('exhaustion rollback leaves run, execution and outbox unchanged together', async () => {
  const run = await dispatchFixture();
  await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
  await db.query(`CREATE FUNCTION h3_reject_review() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='needs_review' THEN RAISE EXCEPTION 'injected aggregate failure'; END IF; RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER h3_reject_review BEFORE UPDATE ON workflow_executions FOR EACH ROW EXECUTE FUNCTION h3_reject_review()');
  mock.method(globalThis, 'fetch', async () => { throw new Error('Transport failed'); });
  try {
    await assert.rejects(runAutomationOutboxTick(1), /injected aggregate failure/);
    const after = await state(run.id);
    assert.equal(after.run.status, 'dispatching');
    assert.equal(after.run.error_code, null);
    assert.equal(after.execution.status, 'queued');
    assert.equal(after.outbox.status, 'claimed');
    assert.equal(after.outbox.attempt_count, 2);
  } finally {
    await db.query('DROP TRIGGER h3_reject_review ON workflow_executions');
    await db.query('DROP FUNCTION h3_reject_review()');
  }
  await db.query("UPDATE automation_dispatch_outbox SET claim_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [run.id]);
  await runAutomationOutboxTick(1);
  const afterRetry = await state(run.id);
  assert.equal(afterRetry.run.status, 'needs_review');
  assert.equal(afterRetry.execution.status, 'needs_review');
  assert.equal(afterRetry.outbox.status, 'needs_review');
  assert.equal(afterRetry.outbox.attempt_count, 3);
});

test('a competing run writer defers settlement without deadlock or repeated HTTP', { timeout: 5000 }, async () => {
  const run = await dispatchFixture();
  const writer = await db.connect();
  let calls = 0;
  try {
    mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      await writer.query('BEGIN');
      await writer.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [run.id]);
      return new Response('{}', { status: 202 });
    });
    assert.equal(await runAutomationOutboxTick(1), 1);
    assert.equal(calls, 1);
    const pending = await state(run.id);
    assert.equal(pending.run.status, 'dispatching');
    assert.equal(pending.outbox.status, 'claimed');
    assert.equal(pending.outbox.attempt_count, 0);
    await writer.query('COMMIT');
    await recomputeWorkflowExecutionStatusForRun(run.id);
    await db.query("UPDATE automation_dispatch_outbox SET claim_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [run.id]);
    assert.equal(await runAutomationOutboxTick(1), 1);
    const recovered = await state(run.id);
    assert.equal(recovered.run.status, 'running');
    assert.equal(recovered.outbox.status, 'delivered');
    assert.equal(recovered.outbox.attempt_count, 0);
    assert.equal(calls, 1);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
});

test('claim lease covers a configured HTTP timeout longer than five minutes', async () => {
  const run = await dispatchFixture();
  const originalTimeout = config.EXECUTION_ENGINE_TIMEOUT_MS;
  config.EXECUTION_ENGINE_TIMEOUT_MS = 600_000;
  try {
    mock.method(globalThis, 'fetch', async () => {
      const row = (await state(run.id)).outbox;
      assert.equal(row.claim_expires_at.getTime() - row.updated_at.getTime(), 630_000);
      return new Response('{}', { status: 202 });
    });
    await runAutomationOutboxTick(1);
  } finally {
    config.EXECUTION_ENGINE_TIMEOUT_MS = originalTimeout;
  }
});

async function dispatchFixture(child = false) {
  const setup = await coordinatedRoot();
  if (child) return (await createDelegatedWorkflowRun(delegationInput(setup, 'recovery-test'))).run;
  await db.query("UPDATE workflow_runs SET status='queued' WHERE id=$1", [setup.parent.id]);
  await db.query("UPDATE workflow_executions SET status='queued' WHERE id=$1", [setup.parent.executionId]);
  await db.query("UPDATE automation_dispatch_outbox SET status='pending',delivered_at=NULL WHERE run_id=$1", [setup.parent.id]);
  return setup.parent;
}

async function state(runId: string) {
  const run = (await db.query('SELECT * FROM workflow_runs WHERE id=$1', [runId])).rows[0];
  const outbox = (await db.query('SELECT * FROM automation_dispatch_outbox WHERE run_id=$1', [runId])).rows[0];
  const execution = (await db.query('SELECT * FROM workflow_executions WHERE id=$1', [run.execution_id])).rows[0];
  return { run, outbox, execution };
}

for (const child of [false, true]) {
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    test(`lost third response preserves committed ${terminal} ${child ? 'child' : 'root'} evidence`, async () => {
      const run = await dispatchFixture(child);
      await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
      let committed: Awaited<ReturnType<typeof state>> | undefined;
      mock.method(globalThis, 'fetch', async () => {
        const response = await callController(commitRun, createRequest({ runId: run.id }, {
          status: terminal,
          assistant_message: { content: 'Retained execution evidence.', format: 'markdown' },
          usage: { input_tokens: 5, output_tokens: 3, tool_calls: 0 },
          timing: { started_at: '2026-10-30T00:00:00.000Z', ended_at: '2026-10-30T00:00:01.000Z' }
        }));
        assert.equal(response.statusCode, 200);
        committed = await state(run.id);
        throw new Error('Dispatch response lost after callback');
      });
      assert.equal(await runAutomationOutboxTick(1), 1);
      const after = await state(run.id);
      assert.deepEqual(after.run, committed!.run);
      assert.deepEqual(after.execution, committed!.execution);
      assert.equal(after.outbox.status, terminal === 'cancelled' ? 'cancelled' : 'delivered');
      assert.equal(after.outbox.attempt_count, 3);
      assert.equal(after.outbox.claim_owner, null);
    });
  }
}

for (const status of ['running', 'waiting_for_approval', 'needs_review']) {
  test(`lost third response preserves observed ${status}`, async () => {
    const run = await dispatchFixture();
    await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
    let observed: Awaited<ReturnType<typeof state>> | undefined;
    mock.method(globalThis, 'fetch', async () => {
      await db.query(`UPDATE workflow_runs SET status=$2,started_at=NOW(),error_code='EXISTING_EVIDENCE',
        uncertain_write=$3,updated_at=NOW() WHERE id=$1`, [run.id, status, status === 'needs_review']);
      await recomputeWorkflowExecutionStatusForRun(run.id);
      observed = await state(run.id);
      throw new Error('Response lost after progress');
    });
    await runAutomationOutboxTick(1);
    const after = await state(run.id);
    assert.deepEqual(after.run, observed!.run);
    assert.deepEqual(after.execution, observed!.execution);
    assert.equal(after.outbox.status, status === 'needs_review' ? 'needs_review' : 'delivered');
  });
}

for (const previousAttempts of [0, 1, 2]) {
  test(`ordinary failure after ${previousAttempts} attempts preserves retry/exhaustion semantics`, async () => {
    const run = await dispatchFixture();
    await db.query('UPDATE automation_dispatch_outbox SET attempt_count=$2 WHERE run_id=$1', [run.id, previousAttempts]);
    mock.method(globalThis, 'fetch', async () => { throw new Error('Unavailable'); });
    await runAutomationOutboxTick(1);
    const after = await state(run.id);
    const exhausted = previousAttempts === 2;
    assert.equal(after.run.status, exhausted ? 'needs_review' : 'queued');
    assert.equal(after.execution.status, exhausted ? 'needs_review' : 'queued');
    assert.equal(after.outbox.status, exhausted ? 'needs_review' : 'failed');
    assert.equal(after.outbox.attempt_count, previousAttempts + 1);
    assert.equal(after.run.uncertain_write, false);
    assert.equal(after.run.error_code, exhausted ? 'DISPATCH_RETRIES_EXHAUSTED' : null);
    assert.equal(after.outbox.claim_owner, null);
    const backoffMs = after.outbox.next_attempt_at.getTime() - after.outbox.updated_at.getTime();
    assert.equal(backoffMs, 2 ** (previousAttempts + 1) * 1000);
  });
}

test('lost response preserves cancellation intent before cancellation finishes', async () => {
  const run = await dispatchFixture();
  await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
  mock.method(globalThis, 'fetch', async () => {
    await db.query('UPDATE workflow_runs SET cancellation_requested_at=NOW() WHERE id=$1', [run.id]);
    throw new Error('Response lost during cancellation');
  });
  await runAutomationOutboxTick(1);
  const after = await state(run.id);
  assert.equal(after.run.status, 'dispatching');
  assert.ok(after.run.cancellation_requested_at);
  assert.equal(after.outbox.status, 'cancelled');
});

test('graph cancellation while HTTP is pending wins over delivery failure', async () => {
  const run = await dispatchFixture();
  await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
  mock.method(globalThis, 'fetch', async () => {
    await cancelWorkflowExecutionGraph(run.executionId);
    throw new Error('Response lost during graph cancellation');
  });
  await runAutomationOutboxTick(1);
  const after = await state(run.id);
  assert.equal(after.run.status, 'cancelled');
  assert.equal(after.execution.status, 'cancelled');
  assert.equal(after.outbox.status, 'cancelled');
  assert.equal(after.outbox.attempt_count, 2);
});

for (const oldOutcome of ['success', 'failure']) {
  test(`same-process reclaimed delivery ignores stale ${oldOutcome}`, async () => {
    const run = await dispatchFixture();
    await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const payloads: unknown[] = [];
    let calls = 0;
    mock.method(globalThis, 'fetch', async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      if (++calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        if (oldOutcome === 'failure') throw new Error('Old response lost');
      } else {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return new Response('{}', { status: 202 });
    });
    const first = runAutomationOutboxTick(1);
    await firstStarted.promise;
    await db.query("UPDATE automation_dispatch_outbox SET claim_expires_at=NOW()-INTERVAL '1 second' WHERE run_id=$1", [run.id]);
    const second = runAutomationOutboxTick(1);
    await secondStarted.promise;
    const owned = await state(run.id);
    try {
      releaseFirst.resolve();
      await first;
      const afterOld = await state(run.id);
      assert.deepEqual(afterOld, owned);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.all([first, second]);
    }
    const after = await state(run.id);
    assert.equal(after.run.status, 'dispatching');
    assert.equal(after.outbox.status, 'delivered');
    assert.equal(after.outbox.attempt_count, 3);
    assert.equal(calls, 2);
    assert.deepEqual(payloads[0], payloads[1]);
  });
}

test('expired claim after callback is reconciled without another HTTP dispatch', async () => {
  const run = await dispatchFixture();
  await db.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [run.id]);
  await recomputeWorkflowExecutionStatusForRun(run.id);
  await db.query(`UPDATE automation_dispatch_outbox SET status='claimed',claim_owner='crashed-worker',
    claim_expires_at=NOW()-INTERVAL '1 second',attempt_count=2 WHERE run_id=$1`, [run.id]);
  mock.method(globalThis, 'fetch', async () => { assert.fail('Progressed run must not be dispatched again'); });
  assert.equal(await runAutomationOutboxTick(1), 1);
  const after = await state(run.id);
  assert.equal(after.run.status, 'running');
  assert.equal(after.outbox.status, 'delivered');
  assert.equal(after.outbox.attempt_count, 2);
  assert.equal(await runAutomationOutboxTick(1), 0);
});

test('an acknowledgement persistence failure is not reclassified as transport exhaustion', async () => {
  const run = await dispatchFixture();
  await db.query('UPDATE automation_dispatch_outbox SET attempt_count=2 WHERE run_id=$1', [run.id]);
  await db.query(`CREATE FUNCTION h3_reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='delivered' THEN RAISE EXCEPTION 'injected settlement failure'; END IF; RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER h3_reject_delivery BEFORE UPDATE ON automation_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION h3_reject_delivery()');
  mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 202 }));
  try {
    await assert.rejects(runAutomationOutboxTick(1), /injected settlement failure/);
    const after = await state(run.id);
    assert.equal(after.run.status, 'dispatching');
    assert.equal(after.execution.status, 'queued');
    assert.equal(after.outbox.status, 'claimed');
    assert.equal(after.outbox.attempt_count, 2);
  } finally {
    await db.query('DROP TRIGGER h3_reject_delivery ON automation_dispatch_outbox');
    await db.query('DROP FUNCTION h3_reject_delivery()');
  }
});
