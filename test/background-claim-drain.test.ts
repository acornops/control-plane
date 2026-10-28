import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { runTargetAutoTriageTick } from '../src/services/auto-triage-worker.js';
import { withRedisLease } from '../src/services/control-plane-coordination.js';
import { ServiceLifecycle, serviceLifecycle } from '../src/services/service-lifecycle.js';
import { runTargetInsightsCheckpointSweep } from '../src/services/target-insights/checkpoint-worker.js';
import { runWebhookDeliverySweep } from '../src/services/webhook-worker.js';
import { repo } from '../src/store/repository.js';
import { installRedisStore } from './helpers/agent-gateway-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let lifecycle: ServiceLifecycle;
const originalAutoTriage = repo.autoTriage;
const originalConfig = {
  TARGET_INSIGHTS_ENABLED: config.TARGET_INSIGHTS_ENABLED,
  WORKSPACE_DISPATCH_ENABLED: config.WORKSPACE_DISPATCH_ENABLED,
  WEBHOOK_WORKER_ENABLED: config.WEBHOOK_WORKER_ENABLED,
  CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED: config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED
};

beforeEach(() => {
  lifecycle = new ServiceLifecycle();
  mock.getter(serviceLifecycle, 'accepting', () => lifecycle.accepting);
  repo.autoTriage = { ...originalAutoTriage };
  config.TARGET_INSIGHTS_ENABLED = true;
  config.WORKSPACE_DISPATCH_ENABLED = true;
  config.WEBHOOK_WORKER_ENABLED = true;
});
afterEach(() => {
  repo.autoTriage = originalAutoTriage;
  Object.assign(config, originalConfig);
  mock.restoreAll();
});

test('a checkpoint sweep finishes its claimed job without claiming the next job after drain', async () => {
  const started = deferred();
  const release = deferred();
  const jobs = ['first', 'next'].map((sessionId) => ({
    workspaceId: 'workspace', targetId: 'target', targetType: 'kubernetes', sessionId,
    lastActivityAt: '2026-01-01T00:00:00Z', leaseOwner: 'owner', config: {},
    toolEnabled: true, sessionActive: false, sessionLastMessageAt: '2026-01-01T00:00:00Z',
    hasActiveRun: false, hasPendingApproval: false
  }));
  const completed: string[] = [];
  mock.method(repo, 'claimDueTargetInsightsCheckpointJobs', async () => jobs.splice(0, 1));
  mock.method(repo, 'finishTargetInsightsCheckpointJob', async (job) => {
    if (job.sessionId === 'first') { started.resolve(); await release.promise; }
    completed.push(job.sessionId);
    return true;
  });

  const sweep = serviceLifecycle.track(runTargetInsightsCheckpointSweep);
  await started.promise;
  lifecycle.beginDrain(1000);
  try { assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 20), false); }
  finally { release.resolve(); await sweep; }

  assert.deepEqual(completed, ['first']);
  assert.deepEqual(jobs.map((job) => job.sessionId), ['next']);
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 100), true);
});

for (const stage of ['terminal reconciliation', 'stopping claim'] as const) {
  test(`auto-triage does not claim due work after drain during ${stage}`, async () => {
    const started = deferred();
    const release = deferred();
    let stoppingClaims = 0;
    let dueClaims = 0;
    mock.method(repo.autoTriage, 'synchronizeTargetAutoTriageTerminalRuns', async () => {
      if (stage === 'terminal reconciliation') { started.resolve(); await release.promise; }
      return [];
    });
    mock.method(repo.autoTriage, 'claimStoppingTargetAutoTriageJobs', async () => {
      stoppingClaims++;
      if (stage === 'stopping claim') { started.resolve(); await release.promise; }
      return [];
    });
    mock.method(repo.autoTriage, 'claimDueTargetAutoTriageJobs', async () => { dueClaims++; return []; });
    mock.method(repo.autoTriage, 'getAutoTriageRuntimeMetricsSnapshot', async () => ({
      activeRuns: 0, queued: 0, blocked: 0, processing: 0, started: 0, stopping: 0, oldestWaitingAgeSeconds: 0
    }));

    const tick = serviceLifecycle.track(runTargetAutoTriageTick);
    await started.promise;
    lifecycle.beginDrain(1000);
    release.resolve();
    assert.equal(await tick, 0);
    assert.equal(stoppingClaims, stage === 'stopping claim' ? 1 : 0);
    assert.equal(dueClaims, 0);
  });
}

test('a webhook sweep does not claim deliveries after drain during expiry cleanup', async () => {
  const started = deferred();
  const release = deferred();
  let claims = 0;
  mock.method(repo, 'purgeExpiredWebhookOutboxEvents', async () => {
    started.resolve();
    await release.promise;
    return 0;
  });
  mock.method(repo, 'claimWebhookDeliveryJobs', async () => { claims++; return []; });
  mock.method(repo, 'getWebhookQueueMetrics', async () => ({
    pending: 0, processing: 0, retrying: 0, paused: 0, oldestAgeSeconds: 0
  }));

  const sweep = serviceLifecycle.track(runWebhookDeliverySweep);
  await started.promise;
  lifecycle.beginDrain(1000);
  release.resolve();
  await sweep;
  assert.equal(claims, 0);
});

test('a scheduler lease acquired after drain is released without starting its task', async () => {
  config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = true;
  const store = new Map<string, string>();
  installRedisStore(store);
  const started = deferred();
  const release = deferred();
  mock.method(redis, 'set', async (key: string, value: string) => {
    store.set(key, value);
    started.resolve();
    await release.promise;
    return 'OK';
  });
  let ran = false;
  const leasedTask = serviceLifecycle.track(() => withRedisLease('drain-race', 30, async () => {
    ran = true;
    return 'completed';
  }));
  await started.promise;
  lifecycle.beginDrain(1000);
  release.resolve();

  assert.equal(await leasedTask, undefined);
  assert.equal(ran, false);
  assert.equal(store.has('cp:lease:drain-race'), false);
});

for (const distributed of [false, true]) {
  test(`a draining scheduler does not acquire work with distributed routing ${distributed}`, async () => {
    config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = distributed;
    installRedisStore(new Map<string, string>());
    lifecycle.beginDrain(1000);
    let ran = false;
    await withRedisLease('draining', 30, async () => { ran = true; });
    assert.equal(ran, false);
  });
}

test('a leased task already running at drain completes and releases its lease', async () => {
  config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = true;
  const store = new Map<string, string>();
  installRedisStore(store);
  const started = deferred();
  const release = deferred();
  const task = serviceLifecycle.track(() => withRedisLease('accepted', 30, async () => {
    started.resolve();
    await release.promise;
    return 'completed';
  }));
  await started.promise;
  lifecycle.beginDrain(1000);
  try { assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 20), false); }
  finally { release.resolve(); }
  assert.equal(await task, 'completed');
  assert.equal(store.has('cp:lease:accepted'), false);
});
