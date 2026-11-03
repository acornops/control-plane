import { installInsightsCapacityFixture } from './helpers/insights-capacity-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { runTargetInsightsCheckpointSweep } from '../src/services/target-insights/checkpoint-worker.js';
import { repo } from '../src/store/repository.js';
import { logger } from '../src/logger.js';

afterEach(() => {
  mock.restoreAll();
});

async function runCheckpoint(
  responseText: string,
  gatewayStatus = 200,
  leaseCurrent = true,
  tailEvents: Array<Record<string, unknown>> = [{ type: 'final', usage: {} }],
  options: { attempts?: number; fetchError?: Error; setupError?: Error } = {}
) {
  const lastActivityAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const job = {
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes' as const,
    sessionId: 'session-1',
    lastActivityAt,
    leaseOwner: 'lease-1',
    attempts: options.attempts ?? 1,
    config: {},
    toolEnabled: true,
    sessionActive: true,
    sessionLastMessageAt: lastActivityAt,
    hasActiveRun: false,
    hasPendingApproval: false
  };
  const finishedJobs: Array<{ status: string; error?: string | null; retryAfter?: string | null }> = [];
  const auditEvents: Array<{ eventType: string; summary?: string; metadata?: Record<string, unknown> }> = [];
  const rescheduledJobs: Array<{ error?: string | null }> = [];
  const warnings: unknown[] = [];
  let claimed = false;

  mock.method(repo, 'claimDueTargetInsightsCheckpointJobs', async () => {
    if (claimed) return [];
    claimed = true;
    return [job];
  });
  installInsightsCapacityFixture();
  mock.method(logger, 'warn', (metadata) => { warnings.push(metadata); });
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
  mock.method(repo, 'listMessages', async () => {
    if (options.setupError) throw options.setupError;
    return { items: [{ role: 'user', content: 'Diagnose recent target behavior.' }] };
  });
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
    if (options.fetchError) throw options.fetchError;
    if (gatewayStatus !== 200) {
      return new Response('sensitive-response-body', { status: gatewayStatus });
    }
    const stream = new ReadableStream({
      start(controller) {
        const events = [{ type: 'delta', text: responseText }, ...tailEvents];
        controller.enqueue(new TextEncoder().encode(
          `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
        ));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  await runTargetInsightsCheckpointSweep();
  return { finishedJobs, auditEvents, rescheduledJobs, warnings };
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
    assert.equal(auditEvents[0].metadata?.httpStatus, 502);
  });

  it('makes permanent gateway client rejections terminal with a safe status and reason', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const result = await runCheckpoint('', status);
      assert.deepEqual(result.finishedJobs.map(({ status, error, retryAfter }) => ({ status, error, retryAfter })), [
        { status: 'failed', error: 'gateway_request_rejected', retryAfter: undefined }
      ]);
      assert.equal(result.auditEvents[0].eventType, 'target_insights.checkpoint.failed.v1');
      assert.equal(result.auditEvents[0].summary, 'Target Insights checkpoint request rejected by gateway');
      assert.equal(result.auditEvents[0].metadata?.reasonCode, 'gateway_request_rejected');
      assert.equal(result.auditEvents[0].metadata?.httpStatus, status);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-response-body/);
    }
  });

  it('retries timeout and rate limit responses with the existing fifteen minute delay', async () => {
    for (const status of [408, 429]) {
      const before = Date.now();
      const { finishedJobs, auditEvents } = await runCheckpoint('', status);
      const retryAt = new Date(finishedJobs[0].retryAfter!).getTime();
      assert.ok(retryAt >= before + 15 * 60_000 && retryAt <= Date.now() + 15 * 60_000);
      assert.equal(finishedJobs[0].error, 'provider_failure');
      assert.equal(auditEvents[0].metadata?.httpStatus, status);
    }
  });

  it('stops transient provider retries at three attempts, including old high-attempt jobs', async () => {
    for (const attempts of [1, 2, 3, 70]) {
      const { finishedJobs } = await runCheckpoint('', 502, true, undefined, { attempts });
      assert.equal(Boolean(finishedJobs[0].retryAfter), attempts < 3);
    }
  });

  it('keeps unknown network failures bounded and excludes exception text', async () => {
    const result = await runCheckpoint('', 200, true, undefined, {
      attempts: 3, fetchError: new Error('sensitive-network-error')
    });
    assert.equal(result.finishedJobs[0].error, 'provider_failure');
    assert.equal(result.finishedJobs[0].retryAfter, undefined);
    assert.equal(result.auditEvents[0].metadata?.httpStatus, undefined);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-network-error/);
  });

  it('bounds the sweep exception retry path without persisting or logging arbitrary errors', async () => {
    for (const attempts of [2, 3, 70]) {
      const result = await runCheckpoint('', 200, true, undefined, {
        attempts, setupError: new Error('sensitive-setup-error')
      });
      assert.equal(result.finishedJobs[0].error, 'exception');
      assert.equal(Boolean(result.finishedJobs[0].retryAfter), attempts < 3);
      assert.deepEqual(result.warnings, [{ reasonCode: 'exception', targetId: 'cluster-1', sessionId: 'session-1' }]);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-setup-error/);
    }
  });

  it('allows a successful no-op after earlier attempts', async () => {
    const { finishedJobs, auditEvents } = await runCheckpoint(
      '{"patches":[{"action":"noop","reasonCode":"already_captured"}]}', 200, true, undefined, { attempts: 70 }
    );
    assert.equal(finishedJobs[0].status, 'noop');
    assert.equal(auditEvents[0].eventType, 'target_insights.checkpoint.noop.v1');
  });

  it('does not record rejected or failed provider outcomes for a stale lease', async () => {
    for (const status of [422, 502]) {
      const { finishedJobs, auditEvents } = await runCheckpoint('', status, false);
      assert.equal(finishedJobs.length, 0);
      assert.equal(auditEvents.length, 0);
    }
  });

  it('rejects incomplete and post-terminal gateway streams as provider failures', async () => {
    const validResponse = '{"patches":[{"action":"noop","reasonCode":"no_durable_learning"}]}';
    for (const tailEvents of [
      [],
      [{ type: 'final', usage: {} }, { type: 'delta', text: 'late' }]
    ]) {
      const { finishedJobs, auditEvents } = await runCheckpoint(
        validResponse,
        200,
        true,
        tailEvents
      );
      assert.equal(finishedJobs[0].status, 'failed');
      assert.equal(finishedJobs[0].error, 'provider_failure');
      assert.equal(auditEvents[0].metadata?.reasonCode, 'provider_failure');
    }
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
