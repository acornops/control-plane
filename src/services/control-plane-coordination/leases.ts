import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { logger } from '../../logger.js';
import { distributedRoutingEnabled } from './common.js';

const deleteIfValueScript = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const renewIfValueScript = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export async function withRedisLease<T>(name: string, ttlSeconds: number, task: () => Promise<T>): Promise<T | undefined> {
  if (!distributedRoutingEnabled()) {
    return task();
  }
  const key = `cp:lease:${name}`;
  const token = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;
  const acquired = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
  if (acquired !== 'OK') return undefined;
  const renewalInterval = setInterval(() => {
    redis
      .eval(renewIfValueScript, 1, key, token, String(ttlSeconds))
      .then((renewed) => {
        if (renewed === 1) return;
        clearInterval(renewalInterval);
        logger.warn({ lease: name }, 'Lost Redis lease before task completed');
      })
      .catch((err) => {
        clearInterval(renewalInterval);
        logger.warn({ err, lease: name }, 'Failed renewing Redis lease');
      });
  }, Math.max(1_000, Math.floor(ttlSeconds * 1000 / 3)));
  renewalInterval.unref();
  try {
    return await task();
  } finally {
    clearInterval(renewalInterval);
    await redis.eval(deleteIfValueScript, 1, key, token).catch((err) => {
      logger.warn({ err, lease: name }, 'Failed releasing Redis lease');
    });
  }
}
