import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3
});

export async function initializeRedis(): Promise<void> {
  if (redis.status === 'ready') return;
  await redis.connect();
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}
