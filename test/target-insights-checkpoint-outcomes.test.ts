import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { runTargetInsightsCheckpointSweep } from '../src/services/target-insights/checkpoint-worker.js';
import { repo } from '../src/store/repository.js';

afterEach(() => {
  mock.restoreAll();
});

async function runCheckpoint(responseText: string, gatewayStatus = 200, leaseCurrent = true) {
  const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const job = {
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes' as const,
    sessionId: 'session-1',
    lastActivityAt,
    leaseOwner: 'lease-1',
    config: {},
    toolEnabled: true,
    sessionActive: true,
    sessionLastMessageAt: lastActivityAt,
    hasActiveRun: false,
    hasPendingApproval: false
  };
  const finishedJobs: Array<{ status: string; error?: string | null; retryAfter?: string | null }> = [];
  const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  const rescheduledJobs: Array<{ error?: string | null }> = [];
  let claimed = false;

  mock.method(repo, 'claimDueTargetInsightsCheckpointJobs', async () => {
    if (claimed) return [];
    claimed = true;
    return [job];
  });
  const client = {
    query: async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release: () => undefined
  };
  mock.method(db, 'connect', async () => client);
  mock.method(repo, 'finishTargetInsightsCheckpointJob', async (params) => {
    finishedJobs.push(params);
    return true;
  });
  mock.method(repo, 'renewTargetInsightsCheckpointJobLeaseIfCurrent', async () => leaseCurrent);
  mock.method(repo, 'rescheduleTargetInsightsCheckpointJob', async (params) => {
    rescheduledJobs.push(params);
    return true;
  });
  mock.method(repo, 'getWorkspaceAiSettings', async () => null);
  mock.method(repo, 'listMessages', async () => ({
    items: [{ role: 'user', content: 'Diagnose recent target behavior.' }]
  }));
  mock.method(repo, 'listTargetInsightsEntries', async () => []);
  mock.method(repo, 'insertWorkspaceAuditEvent', async (event) => {
    auditEvents.push(event);
    return {
      id: 'audit-1',
      workspaceId: event.workspaceId,
      category: event.category,
      eventType: event.eventType,
      actor: { type: event.actorType || 'system' },
      object: { type: event.objectType, id: event.objectId },
      summary: event.summary,
      metadata: event.metadata || {},
      occurredAt: '2026-06-29T01:00:00.000Z'
    };
  });
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/llm/provider-credentials?')) {
      return new Response(JSON.stringify({
        workspace_id: 'workspace-1',
        providers: [
          { provider: 'openai', enabled: true, configured: true },
          { provider: 'anthropic', enabled: true, configured: false },
          { provider: 'gemini', enabled: true, configured: false }
        ]
      }), { status: 200 });
    }
    if (gatewayStatus !== 200) {
      return new Response('provider unavailable', { status: gatewayStatus });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          type: 'delta',
          text: responseText
        })));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  await runTargetInsightsCheckpointSweep();
  return { finishedJobs, auditEvents, rescheduledJobs };
}

describe('Target Insights checkpoint outcomes', () => {
  it('records an explicit no-op with its bounded reason', async () => {
    const { finishedJobs, auditEvents } = await runCheckpoint(
      '{"patches":[{"action":"noop","reasonCode":"no_durable_learning"}]}'
    );

    assert.equal(finishedJobs[0].status, 'noop');
    assert.equal(auditEvents[0].eventType, 'target_insights.checkpoint.noop.v1');
    assert.equal(auditEvents[0].metadata?.outcome, 'noop');
    assert.equal(auditEvents[0].metadata?.reasonCode, 'no_durable_learning');
  });

  it('records malformed model output as invalid instead of no changes', async () => {
    const { finishedJobs, auditEvents } = await runCheckpoint(
      '{"patches":[{"action":"create","title":"Incomplete"}]}'
    );

    assert.deepEqual(
      {
        status: finishedJobs[0].status,
        error: finishedJobs[0].error,
        retryAfter: finishedJobs[0].retryAfter
      },
      { status: 'failed', error: 'invalid_schema', retryAfter: undefined }
    );
    assert.equal(auditEvents[0].eventType, 'target_insights.checkpoint.invalid_response.v1');
    assert.equal(auditEvents[0].metadata?.outcome, 'invalid_response');
    assert.equal(auditEvents[0].metadata?.rejectedPatchCount, 1);
  });

  it('keeps provider failures retryable and reports a safe reason', async () => {
    const { finishedJobs, auditEvents } = await runCheckpoint('', 502);

    assert.equal(finishedJobs[0].status, 'failed');
    assert.equal(finishedJobs[0].error, 'provider_failure');
    assert.ok(finishedJobs[0].retryAfter);
    assert.equal(auditEvents[0].eventType, 'target_insights.checkpoint.failed.v1');
    assert.equal(auditEvents[0].metadata?.reasonCode, 'provider_failure');
  });

  it('does not record a terminal outcome after the checkpoint lease becomes stale', async () => {
    const { finishedJobs, auditEvents, rescheduledJobs } = await runCheckpoint(
      '{"patches":[{"action":"noop","reasonCode":"no_durable_learning"}]}',
      200,
      false
    );

    assert.equal(finishedJobs.length, 0);
    assert.equal(auditEvents.length, 0);
    assert.equal(rescheduledJobs[0].error, 'state_changed');
  });
});
