import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { claimAgentOwner, clearAgentOwnerIfCurrent, getAgentOwner, refreshAgentOwner } from '../src/services/control-plane-coordination/agent-owner.js';

test('real Redis owner drain and renewal preserve fencing across replacement', async () => {
  assert.ok(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  assert.equal(config.DATABASE_URL, process.env.CONTROL_PLANE_TEST_DATABASE_URL);
  const enabled = config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED;
  config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = true;
  const target = `drain-test-${randomUUID()}`;
  const key = `cp:agent:owner:${target}`;
  try {
    await claimAgentOwner({ clusterId: target, connectionId: 'old', workspaceId: 'test' });
    assert.equal(await refreshAgentOwner(target, 'old', 'draining'), true);
    assert.equal((await getAgentOwner(target))?.state, 'draining');
    assert.equal(await refreshAgentOwner(target, 'old'), true);
    assert.equal((await getAgentOwner(target))?.state, 'draining');
    await redis.set(key, JSON.stringify({ instanceId: 'replacement', connectionId: 'new', workspaceId: 'test', updatedAt: new Date().toISOString() }), 'EX', 30);
    assert.equal(await refreshAgentOwner(target, 'old', 'draining'), false);
    assert.equal(await clearAgentOwnerIfCurrent(target, 'old'), false);
    assert.equal((await getAgentOwner(target))?.connectionId, 'new');
    assert.equal((await getAgentOwner(target))?.state, undefined);
  } finally {
    await redis.del(key);
    await redis.quit();
    config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = enabled;
  }
});
