import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { workspaceMemberDiscoveryRateLimited } from '../src/auth/workspace-member-discovery-rate-limit.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

afterEach(() => mock.restoreAll());

describe('workspace member discovery rate limit', () => {
  it('increments and assigns expiry atomically', async () => {
    let argumentsSeen: unknown[] = [];
    mock.method(redis, 'eval', async (...args: unknown[]) => {
      argumentsSeen = args;
      return config.WORKSPACE_MEMBER_DISCOVERY_RATE_LIMIT_PER_MINUTE;
    });

    assert.equal(await workspaceMemberDiscoveryRateLimited('user-1'), false);
    assert.match(String(argumentsSeen[0]), /INCR/);
    assert.match(String(argumentsSeen[0]), /EXPIRE/);
    assert.deepEqual(
      argumentsSeen.slice(1),
      [1, 'cp:workspace_member_discovery:user-1', 60]
    );
  });

  it('rejects requests above the configured limit', async () => {
    mock.method(
      redis,
      'eval',
      async () => config.WORKSPACE_MEMBER_DISCOVERY_RATE_LIMIT_PER_MINUTE + 1
    );

    assert.equal(await workspaceMemberDiscoveryRateLimited('user-1'), true);
  });
});
