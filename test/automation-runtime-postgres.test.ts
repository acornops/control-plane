import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { loadAutomationDiagnostics } from '../src/services/automation-diagnostics.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { createDelegatedWorkflowRun } from '../src/store/repository-workflow-run-delegations.js';
import { coordinatedRoot, delegationInput } from './helpers/workflow-delegation-postgres-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

const originalAdmission = config.WORKSPACE_ADMISSION_ENABLED;
const originalDispatch = config.WORKSPACE_DISPATCH_ENABLED;
beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  config.WORKSPACE_ADMISSION_ENABLED = true;
  config.WORKSPACE_DISPATCH_ENABLED = true;
});
afterEach(() => {
  mock.restoreAll();
  config.WORKSPACE_ADMISSION_ENABLED = originalAdmission;
  config.WORKSPACE_DISPATCH_ENABLED = originalDispatch;
});
after(closeAutomationDatabaseFixtures);

for (const scenario of [
  { admission: true, dispatch: true, status: 'ok' },
  { admission: false, dispatch: true, status: 'ok' },
  { admission: true, dispatch: false, status: 'disabled' }
] as const) {
  test(`diagnostics report admission=${scenario.admission}, dispatch=${scenario.dispatch}`, async () => {
    config.WORKSPACE_ADMISSION_ENABLED = scenario.admission;
    config.WORKSPACE_DISPATCH_ENABLED = scenario.dispatch;
    const diagnostics = await loadAutomationDiagnostics('workspace-1');
    assert.equal(diagnostics.status, scenario.status);
    assert.deepEqual(diagnostics.runtime, {
      admissionEnabled: scenario.admission,
      dispatchEnabled: scenario.dispatch,
      workerIntervalMs: 1000
    });
  });
}

test('workflow dispatch pause retains accepted work and reopening delivers it exactly once', async () => {
  await installAutomationTemplateFixtures();
  const setup = await coordinatedRoot();
  const { run } = await createDelegatedWorkflowRun(delegationInput(setup, 'dispatch-pause'));
  let requests = 0;
  mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response('{}', { status: 202 });
  });
  config.WORKSPACE_DISPATCH_ENABLED = false;
  assert.equal(await runAutomationOutboxTick(), 0);
  const pending = (await db.query('SELECT status,attempt_count FROM automation_dispatch_outbox WHERE run_id=$1', [run.id])).rows[0];
  assert.deepEqual(pending, { status: 'pending', attempt_count: 0 });
  assert.equal(requests, 0);

  // Closing new admission must not stop delivery of work already accepted.
  config.WORKSPACE_ADMISSION_ENABLED = false;
  config.WORKSPACE_DISPATCH_ENABLED = true;
  assert.equal(await runAutomationOutboxTick(), 1);
  assert.equal(await runAutomationOutboxTick(), 0);
  const delivered = (await db.query('SELECT status,attempt_count FROM automation_dispatch_outbox WHERE run_id=$1', [run.id])).rows[0];
  assert.deepEqual(delivered, { status: 'delivered', attempt_count: 1 });
  assert.equal(requests, 1);
  assert.equal((await db.query('SELECT status FROM workflow_runs WHERE id=$1', [run.id])).rows[0].status, 'dispatching');
  await assert.rejects(createDelegatedWorkflowRun(delegationInput(setup, 'admission-paused')), {
    code: 'WORKSPACE_ADMISSION_PAUSED'
  });
});
