import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claimAgentOwner,
  clearAgentOwnerIfCurrent,
  getAgentOwner,
  refreshAgentOwner,
  withRedisLease
} from '../src/services/control-plane-coordination.js';
import {
  agentOwnerKey,
  installRedisStore,
  setOwner,
  setupControlPlaneCoordinationTest,
  sleep,
  teardownControlPlaneCoordinationTest
} from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

describe('control-plane ownership and leases', () => {
  it('claims, refreshes, and clears agent ownership by connection identity', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);

    await claimAgentOwner({
      clusterId: 'cluster-1',
      connectionId: 'conn-1',
      workspaceId: 'workspace-1',
      agentVersion: 'agent-test'
    });

    assert.deepEqual(await getAgentOwner('cluster-1'), {
      instanceId: 'cp-test-a',
      connectionId: 'conn-1',
      workspaceId: 'workspace-1',
      agentVersion: 'agent-test',
      updatedAt: (await getAgentOwner('cluster-1'))?.updatedAt
    });
    assert.equal(await refreshAgentOwner('cluster-1', 'wrong-conn'), false);
    assert.equal(await refreshAgentOwner('cluster-1', 'conn-1'), true);
    assert.equal(await clearAgentOwnerIfCurrent('cluster-1', 'wrong-conn'), false);
    assert.equal(await clearAgentOwnerIfCurrent('cluster-1', 'conn-1'), true);
    assert.equal(await getAgentOwner('cluster-1'), undefined);
  });

  it('does not let a stale owner refresh overwrite a newer agent owner', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    await claimAgentOwner({
      clusterId: 'cluster-stolen',
      connectionId: 'conn-old',
      workspaceId: 'workspace-1',
      agentVersion: 'agent-test'
    });
    setOwner(store, 'cluster-stolen', {
      instanceId: 'cp-test-b',
      connectionId: 'conn-new',
      workspaceId: 'workspace-1',
      agentVersion: 'agent-new',
      updatedAt: '2026-05-19T00:01:00.000Z'
    });

    assert.equal(await refreshAgentOwner('cluster-stolen', 'conn-old'), false);
    assert.deepEqual(await getAgentOwner('cluster-stolen'), {
      instanceId: 'cp-test-b',
      connectionId: 'conn-new',
      workspaceId: 'workspace-1',
      agentVersion: 'agent-new',
      updatedAt: '2026-05-19T00:01:00.000Z'
    });
  });

  it('uses Redis leases to run only the owner task', async () => {
    const store = new Map<string, string>([['cp:lease:retention', 'other-owner']]);
    installRedisStore(store);
    let calls = 0;

    const skipped = await withRedisLease('retention', 30, async () => {
      calls += 1;
      return 'ran';
    });

    assert.equal(skipped, undefined);
    assert.equal(calls, 0);
    store.delete('cp:lease:retention');

    const result = await withRedisLease('retention', 30, async () => {
      calls += 1;
      return 'ran';
    });

    assert.equal(result, 'ran');
    assert.equal(calls, 1);
    assert.equal(store.has('cp:lease:retention'), false);
  });

  it('renews Redis leases while the owner task is still running', async () => {
    const store = new Map<string, string>();
    const { evalCalls } = installRedisStore(store);

    const result = await withRedisLease('slow-job', 1, async () => {
      await sleep(1100);
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(evalCalls.some((call) => call.kind === 'renew' && call.key === 'cp:lease:slow-job'), true);
    assert.equal(store.has('cp:lease:slow-job'), false);
  });

  it('does not renew a Redis lease after the token no longer matches', async () => {
    const store = new Map<string, string>();
    const { evalCalls } = installRedisStore(store);

    const result = await withRedisLease('stolen-job', 1, async () => {
      store.set('cp:lease:stolen-job', 'other-owner');
      await sleep(1100);
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(evalCalls.some((call) => call.kind === 'renew' && call.key === 'cp:lease:stolen-job'), true);
    assert.equal(store.get('cp:lease:stolen-job'), 'other-owner');
  });

  it('keeps owner key helpers aligned with Redis key naming', () => {
    assert.equal(agentOwnerKey('cluster-1'), 'cp:agent:owner:cluster-1');
  });
});
