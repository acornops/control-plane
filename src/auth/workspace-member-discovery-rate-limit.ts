import { config } from '../config.js';
import { redis } from '../infra/redis.js';

export async function workspaceMemberDiscoveryRateLimited(userId: string): Promise<boolean> {
  const windowSeconds = 60;
  const key = `cp:workspace_member_discovery:${userId}`;
  const count = Number(await redis.eval(
    `local current = redis.call('INCR', KEYS[1])
     if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return current`,
    1,
    key,
    windowSeconds
  ));
  return count > config.WORKSPACE_MEMBER_DISCOVERY_RATE_LIMIT_PER_MINUTE;
}
