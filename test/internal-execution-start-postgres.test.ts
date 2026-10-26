import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { ingestRunEvents } from '../src/controllers/internal-execution-controller.js';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { db } from '../src/infra/db.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import type { RunStatus } from '../src/types/domain.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { callController, createRequest, createResponse } from './helpers/controller-regression-fixtures.js';

const dispatchEnabled = config.WORKSPACE_DISPATCH_ENABLED;
const startedAt = '2026-10-26T00:00:00.000Z';

beforeEach(async () => {
  config.WORKSPACE_DISPATCH_ENABLED = false;
  await resetAutomationDatabaseFixtures();
});
afterEach(() => {
  mock.restoreAll();
  config.WORKSPACE_DISPATCH_ENABLED = dispatchEnabled;
  runtime.runEventBuffer.clear();
});
after(closeAutomationDatabaseFixtures);

async function addRun(status: RunStatus = 'dispatching') {
  const session = await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Approval resume');
  const message = await repo.addMessage(session.id, 'user', 'Restart after approval.');
  return repo.addRun({
    id: randomUUID(), workspaceId: 'workspace-1', targetId: 'cluster-1',
    sessionId: session.id, messageId: message.id,
    llmProvider: 'openai', llmModel: 'gpt-5-nano',
    llmReasoningSummaryMode: 'off', llmReasoningEffort: 'low',
    toolAccessMode: 'read_write', status, startedAt, requestedAt: startedAt
  });
}

async function ingestStart(runId: string) {
  const request = createRequest({ runId }, {
    events: [{ runId, seq: 17, ts: new Date().toISOString(), type: 'run_started', payload: {} }]
  });
  const response = { ...createResponse(), locals: {} };
  await ingestRunEvents(request as never, response as never, (error?: unknown) => { if (error) throw error; });
  assert.equal(response.statusCode, 200);
}

describe('durable interactive run-start transitions', () => {
  it('records the first start time when the worker starts running', async () => {
    const run = await addRun();
    await repo.updateRun(run.id, { startedAt: undefined });
    await ingestStart(run.id);
    const updated = await repo.getRun(run.id);
    assert.equal(updated?.status, 'running');
    assert.ok(updated?.startedAt);
    assert.notEqual(updated.startedAt, startedAt);
  });

  for (const status of ['queued', 'dispatching', 'running'] as const) {
    it(`starts a ${status} run without resetting its original start time`, async () => {
      const run = await addRun(status);
      await ingestStart(run.id);
      const updated = await repo.getRun(run.id);
      assert.equal(updated?.status, 'running');
      assert.equal(updated?.startedAt, startedAt);
    });
  }

  for (const timing of ['before ingestion', 'during ingestion'] as const) {
    it(`preserves an approval created ${timing} and redispatches after its decision`, async () => {
      const run = await addRun();
      const createApproval = () => repo.createRunToolApproval({
        runId: run.id, workspaceId: run.workspaceId, targetId: run.targetId,
        toolCallId: 'second-write', toolName: 'restart_workload',
        toolRef: { serverId: 'builtin:agentk', toolName: 'restart_workload' },
        arguments: { namespace: 'default', name: 'web' }, requestedBy: 'user-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        continuationState: { schema_version: 1, state: { step: 'awaiting_approval' } }
      });
      if (timing === 'before ingestion') {
        await createApproval();
      } else {
        const append = repo.appendRunEvents;
        mock.method(repo, 'appendRunEvents', async (...args: Parameters<typeof append>) => {
          await createApproval();
          return append(...args);
        });
      }
      await ingestStart(run.id);
      assert.equal((await repo.getRun(run.id))?.status, 'waiting_for_approval');
      const [approval] = await repo.listRunToolApprovals(run.id);
      assert.equal(approval.status, 'pending');
      const response = await callController(decideRunApproval, createRequest(
        { runId: run.id, approvalId: approval.id }, { decision: 'approved' }
      ));
      assert.equal(response.statusCode, 200);
      // The public decision schedules a microtask; wait for its durable outbox entry,
      // without contacting an execution engine or executing the approved tool.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const outbox = await db.query(
          'SELECT status, payload FROM automation_dispatch_outbox WHERE run_id = $1', [run.id]
        );
        if (outbox.rowCount) {
          assert.equal(outbox.rows[0].status, 'pending');
          assert.equal(outbox.rows[0].payload.resume, true);
          assert.equal((await repo.getRun(run.id))?.status, 'dispatching');
          assert.equal((await repo.getRunToolApproval(approval.id))?.status, 'approved');
          return;
        }
        await delay(10);
      }
      assert.fail('Approved run was not queued for redispatch');
    });
  }

  for (const status of ['cancelling', 'cancelled', 'completed', 'failed'] as const) {
    it(`does not overwrite a concurrent transition to ${status}`, async () => {
      const run = await addRun();
      const append = repo.appendRunEvents;
      mock.method(repo, 'appendRunEvents', async (...args: Parameters<typeof append>) => {
        await repo.updateRun(run.id, { status });
        return append(...args);
      });
      await ingestStart(run.id);
      assert.equal((await repo.getRun(run.id))?.status, status);
    });
  }
});
