import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  createWorkspaceWorkflowEventTrigger,
  receiveWorkflowEventTriggerWebhook,
  rotateWorkflowEventTriggerSigningSecret,
  updateWorkflowEventTrigger
} from '../src/controllers/workflow-event-triggers-controller.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { runWorkflowEventTriggerTick } from '../src/services/workflow-event-trigger-worker.js';
import { repo } from '../src/store/repository.js';
import {
  acceptWorkflowWebhookEvent,
  getWorkflowEventTrigger
} from '../src/store/repository-workflow-event-triggers.js';
import { signWebhookPayload } from '../src/utils/crypto.js';
import {
  callController,
  createReadyMcpReadinessResponse,
  createRequest,
  createResponse,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isMcpReadinessRequest,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  installWorkspace('admin');
});

afterEach(restoreControllerRegressionState);
after(closeAutomationDatabaseFixtures);

async function createWebhookTrigger(): Promise<{
  id: string;
  secret: string;
}> {
  const response = await callController(createWorkspaceWorkflowEventTrigger, createRequest(
    { workspaceId: 'workspace-1' },
    {
      workflowId: 'cluster-triage',
      name: 'External triage',
      sourceType: 'webhook',
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    }
  ));
  assert.equal(response.statusCode, 201);
  const body = response.body as {
    trigger: { id: string; principal: { id: string } };
    webhook: { secret: string };
  };
  assert.equal(body.trigger.principal.id, 'user-1');
  return { id: body.trigger.id, secret: body.webhook.secret };
}

async function sendSignedWebhook(input: {
  triggerId: string;
  secret: string;
  eventId: string;
}): Promise<ReturnType<typeof createResponse>> {
  const rawBody = JSON.stringify({ inputs: { target: 'cluster-1' } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'x-acornops-event-id': input.eventId,
    'x-acornops-timestamp': timestamp,
    'x-acornops-signature': `v1=${signWebhookPayload(input.secret, timestamp, rawBody)}`
  };
  const req = {
    params: { triggerId: input.triggerId },
    body: JSON.parse(rawBody),
    rawBody,
    header: (name: string) => headers[name.toLowerCase()]
  };
  const res = createResponse();
  await receiveWorkflowEventTriggerWebhook(req as never, res as never, (error?: unknown) => {
    if (error) throw error;
  });
  return res;
}

describe('workflow event triggers with PostgreSQL', () => {
  it('authorizes the mutation workspace before resolving a trigger ID', async () => {
    const trigger = await createWebhookTrigger();
    repo.getWorkspaceRole = async (workspaceId: string) => (
      workspaceId === 'workspace-1' ? 'admin' : null
    );

    const response = await callController(updateWorkflowEventTrigger, createRequest(
      { triggerId: trigger.id },
      { workspaceId: 'workspace-2', enabled: false }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('accepts signed retries idempotently and recovers delivery without a second execution', async () => {
    const trigger = await createWebhookTrigger();
    mock.method(redis, 'eval', async () => 1);
    mock.method(globalThis, 'fetch', async (input, init) => {
      if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
      if (isWorkspaceAiCredentialStatusRequest(input, init)) {
        return new Response(
          JSON.stringify(createWorkspaceAiCredentialStatusResponse()),
          { status: 200 }
        );
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });

    const accepted = await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId: 'source-event-1'
    });
    const replayed = await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId: 'source-event-1'
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(replayed.statusCode, 202);

    await db.query(
      `UPDATE automation_trigger_deliveries
       SET status='claimed',claim_owner='crashed-worker',
           claim_expires_at=NOW()-INTERVAL '1 second'
       WHERE trigger_id=$1`,
      [trigger.id]
    );
    assert.equal(await runWorkflowEventTriggerTick(), 1);
    const first = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM workflow_executions
       WHERE workspace_id='workspace-1' AND trigger_id=$1 AND occurrence_key='source-event-1'`,
      [trigger.id]
    );
    assert.equal(first.rows[0].count, 1);

    await db.query(
      `UPDATE automation_trigger_deliveries
       SET status='failed',next_attempt_at=NOW(),claim_owner=NULL,claim_expires_at=NULL
       WHERE trigger_id=$1`,
      [trigger.id]
    );
    assert.equal(await runWorkflowEventTriggerTick(), 1);
    const recovered = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM workflow_executions
       WHERE workspace_id='workspace-1' AND trigger_id=$1 AND occurrence_key='source-event-1'`,
      [trigger.id]
    );
    assert.equal(recovered.rows[0].count, 1);
    assert.equal((await getWorkflowEventTrigger(trigger.id))?.lastStatus, 'dispatched');
  });

  it('rejects an accepted event if its trigger is paused before dispatch', async () => {
    const trigger = await createWebhookTrigger();
    mock.method(redis, 'eval', async () => 1);
    await db.query(
      `UPDATE workflow_event_triggers
       SET last_execution_id='prior-successful-execution',last_run_id='prior-successful-run'
       WHERE id=$1`,
      [trigger.id]
    );
    assert.equal((await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId: 'paused-event-1'
    })).statusCode, 202);

    const paused = await callController(updateWorkflowEventTrigger, createRequest(
      { triggerId: trigger.id },
      { workspaceId: 'workspace-1', enabled: false }
    ));
    assert.equal(paused.statusCode, 200);
    assert.equal(await runWorkflowEventTriggerTick(), 1);

    const delivery = await db.query(
      'SELECT status FROM automation_trigger_deliveries WHERE trigger_id=$1',
      [trigger.id]
    );
    const executions = await db.query(
      'SELECT COUNT(*)::int AS count FROM workflow_executions WHERE trigger_id=$1',
      [trigger.id]
    );
    assert.equal(delivery.rows[0].status, 'rejected');
    assert.equal(executions.rows[0].count, 0);
    const durablePointer = await getWorkflowEventTrigger(trigger.id);
    assert.equal(durablePointer?.lastStatus, 'rejected');
    assert.equal(durablePointer?.lastExecutionId, 'prior-successful-execution');
    assert.equal(durablePointer?.lastRunId, 'prior-successful-run');
  });

  it('invalidates an in-flight request when its signing secret is rotated', async () => {
    const trigger = await createWebhookTrigger();
    const staleTrigger = await getWorkflowEventTrigger(trigger.id);
    assert.ok(staleTrigger);

    const rotated = await callController(
      rotateWorkflowEventTriggerSigningSecret,
      createRequest({ triggerId: trigger.id }, { workspaceId: 'workspace-1' })
    );
    assert.equal(rotated.statusCode, 200);

    const result = await acceptWorkflowWebhookEvent({
      trigger: staleTrigger,
      eventId: 'stale-secret-event',
      occurredAt: new Date().toISOString(),
      payload: { inputs: { target: 'cluster-1' } },
      maxEventsPerMinute: 60
    });
    assert.equal(result, 'inactive');
    const events = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM automation_trigger_events
       WHERE source_type='webhook' AND source_id=$1`,
      [trigger.id]
    );
    assert.equal(events.rows[0].count, 0);
  });

  it('accepts an idempotent replay at the rate cap and rejects a new event', async () => {
    const trigger = await createWebhookTrigger();
    mock.method(redis, 'eval', async () => 1);
    const eventId = 'event-at-rate-cap';
    assert.equal((await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId
    })).statusCode, 202);

    await db.query(
      `INSERT INTO automation_trigger_events (
         id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at
       )
       SELECT gen_random_uuid()::text,'workspace-1','workflow.webhook.received.v1',
         'webhook',$1,'rate-cap-' || value::text,'{}'::jsonb,NOW()
       FROM generate_series(1,59) AS value`,
      [trigger.id]
    );

    assert.equal((await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId
    })).statusCode, 202);
    const limited = await sendSignedWebhook({
      triggerId: trigger.id,
      secret: trigger.secret,
      eventId: 'new-event-over-rate-cap'
    });
    assert.equal(limited.statusCode, 429);
    assert.equal((limited.body as { error: { code: string } }).error.code, 'WEBHOOK_RATE_LIMITED');
  });
});
