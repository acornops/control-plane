import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { checkRedisHealth, closeRedis, initializeRedis, redis } from '../../src/infra/redis.js';

let restoreRedisStatus = () => {};

function overrideRedisStatus(value: string): void {
  const hadOwn = Object.prototype.hasOwnProperty.call(redis, 'status');
  const original = Object.getOwnPropertyDescriptor(redis, 'status');

  Object.defineProperty(redis, 'status', {
    configurable: true,
    value
  });

  restoreRedisStatus = () => {
    if (hadOwn && original) {
      Object.defineProperty(redis, 'status', original);
      return;
    }
    delete (redis as { status?: string }).status;
  };
}

afterEach(() => {
  restoreRedisStatus();
  restoreRedisStatus = () => {};
  mock.restoreAll();
});

describe('redis helpers', () => {
  it('skips connect when Redis is already ready', async () => {
    overrideRedisStatus('ready');
    const connectMock = mock.method(redis, 'connect', async () => undefined as never);

    await initializeRedis();

    assert.equal(connectMock.mock.callCount(), 0);
  });

  it('connects when Redis is not ready', async () => {
    overrideRedisStatus('wait');
    const connectMock = mock.method(redis, 'connect', async () => undefined as never);

    await initializeRedis();

    assert.equal(connectMock.mock.callCount(), 1);
  });

  it('treats only PONG as healthy', async () => {
    mock.method(redis, 'ping', async () => 'PONG');
    assert.equal(await checkRedisHealth(), true);

    mock.restoreAll();
    mock.method(redis, 'ping', async () => 'NOPE');
    assert.equal(await checkRedisHealth(), false);
  });

  it('returns unhealthy when ping throws', async () => {
    mock.method(redis, 'ping', async () => {
      throw new Error('redis unavailable');
    });

    assert.equal(await checkRedisHealth(), false);
  });

  it('quits only when the connection has not ended', async () => {
    overrideRedisStatus('ready');
    const quitMock = mock.method(redis, 'quit', async () => 'OK');

    await closeRedis();

    assert.equal(quitMock.mock.callCount(), 1);

    mock.restoreAll();
    overrideRedisStatus('end');
    const endedQuitMock = mock.method(redis, 'quit', async () => 'OK');

    await closeRedis();

    assert.equal(endedQuitMock.mock.callCount(), 0);
  });
});
