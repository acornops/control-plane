import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import express from 'express';
import { config } from '../src/config.js';
import { AgentGateway } from '../src/agent/ws-server.js';
import { AgentUnavailableError } from '../src/agent/types.js';
import { beginAgentDispatch, waitForOwnerHandoff } from '../src/agent/owner-handoff.js';
import { redis } from '../src/infra/redis.js';
import { ServiceLifecycle, installHandlerTracking } from '../src/services/service-lifecycle.js';
import { installRedisStore, setOwner, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);
test('cancelling the caller connection stops predispatch handoff waiting', async () => {
  const oldTimeout = config.AGENT_HANDOFF_TIMEOUT_MS;
  config.AGENT_HANDOFF_TIMEOUT_MS = 1000;
  const owners = new Map<string, string>();
  installRedisStore(owners);
  setOwner(owners, 'target', { instanceId: 'old', connectionId: 'old', workspaceId: 'workspace', updatedAt: 'now', state: 'draining' });
  const lifecycle = new ServiceLifecycle();
  const gateway = new AgentGateway();
  const app = express();
  app.use(lifecycle.admission);
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  app.post('/command', async (_req, res) => {
    started();
    try { await gateway.sendJsonRpc('target', 'tools/list', {}); }
    catch { res.status(503).end(); }
    finally { finished(); }
  });
  installHandlerTracking(app, lifecycle);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const req = request({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/command', method: 'POST' });
  req.on('error', () => undefined);
  req.end();
  await began;
  req.destroy();
  try { assert.equal(await lifecycle.waitForIdle(performance.now() + 300), true); }
  finally {
    await done;
    config.AGENT_HANDOFF_TIMEOUT_MS = oldTimeout;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('handoff deadline remains bounded while an owner read stalls', async () => {
  const { mock } = await import('node:test');
  const { redis } = await import('../src/infra/redis.js');
  const oldTimeout = config.AGENT_HANDOFF_TIMEOUT_MS;
  config.AGENT_HANDOFF_TIMEOUT_MS = 125;
  const owners = new Map<string, string>();
  installRedisStore(owners);
  const owner = { instanceId: 'old', connectionId: 'old', workspaceId: 'workspace', updatedAt: 'now', state: 'draining' };
  let release!: () => void;
  const read = new Promise<string | null>((resolve) => { release = () => resolve(null); });
  let reads = 0;
  mock.method(redis, 'get', () => ++reads === 1 ? Promise.resolve(JSON.stringify(owner)) : read);
  const gateway = new AgentGateway();
  const command = gateway.sendJsonRpc('target', 'tools/list', {});
  try {
    const ended = await Promise.race([command.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
    assert.equal(ended, true);
  } finally {
    release();
    await command.catch(() => undefined);
    config.AGENT_HANDOFF_TIMEOUT_MS = oldTimeout;
  }
});


test('handoff deadline stops applying once command dispatch begins', async () => {
  const { beginAgentDispatch, waitForOwnerHandoff } = await import('../src/agent/owner-handoff.js');
  const owners = new Map<string, string>();
  installRedisStore(owners);
  setOwner(owners, 'target', { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' });
  const value = await waitForOwnerHandoff('target', performance.now() + 200, async () => {
    beginAgentDispatch();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return 'accepted-result';
  });
  assert.equal(value, 'accepted-result');
});

test('handoff deadline bounds resumed owner checks and prevents a late publication', async () => {
  const { mock } = await import('node:test');
  const { redis } = await import('../src/infra/redis.js');
  const oldTimeout = config.AGENT_HANDOFF_TIMEOUT_MS;
  config.AGENT_HANDOFF_TIMEOUT_MS = 180;
  installRedisStore(new Map<string, string>());
  const owner = { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' };
  let release!: () => void;
  const read = new Promise<string>((resolve) => { release = () => resolve(JSON.stringify(owner)); });
  let reads = 0;
  let published = 0;
  mock.method(redis, 'get', () => {
    reads++;
    if (reads === 1) return Promise.resolve(JSON.stringify({ ...owner, state: 'draining' }));
    if (reads === 2) return Promise.resolve(JSON.stringify(owner));
    return read;
  });
  mock.method(redis, 'publish', async () => { published++; return 0; });
  const command = new AgentGateway().sendJsonRpc('target', 'tools/list', {});
  try {
    const ended = await Promise.race([command.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300))]);
    assert.equal(ended, true, 'resumed predispatch owner read must remain bounded');
  } finally {
    release();
    await command.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    config.AGENT_HANDOFF_TIMEOUT_MS = oldTimeout;
  }
  assert.equal(published, 0, 'a late owner lookup must not dispatch after the handoff deadline');
});

test('a settled handoff timeout prevents publication when its timer fires before the monotonic deadline', async (context) => {
  const { mock } = await import('node:test');
  const { redis } = await import('../src/infra/redis.js');
  const oldTimeout = config.AGENT_HANDOFF_TIMEOUT_MS;
  config.AGENT_HANDOFF_TIMEOUT_MS = 180;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  installRedisStore(new Map<string, string>());
  const owner = { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' };
  let release!: () => void;
  const read = new Promise<string>((resolve) => { release = () => resolve(JSON.stringify(owner)); });
  let reads = 0;
  let published = 0;
  mock.method(redis, 'get', () => {
    reads++;
    if (reads === 1) return Promise.resolve(JSON.stringify({ ...owner, state: 'draining' }));
    if (reads === 2) return Promise.resolve(JSON.stringify(owner));
    return read;
  });
  mock.method(redis, 'publish', async () => { published++; return 0; });
  const command = new AgentGateway().sendJsonRpc('target', 'tools/list', {});
  try {
    await nextTurn();
    now = 100;
    context.mock.timers.tick(100);
    await nextTurn();
    assert.equal(reads, 3, 'the resumed owner check must be stalled before timeout');
    const rejected = assert.rejects(command, AgentUnavailableError);
    // Native timers truncate fractional delays; settlement must revoke dispatch
    // even when the monotonic clock has not quite reached the deadline.
    now = 179.5;
    context.mock.timers.tick(80);
    await rejected;
    release();
    await nextTurn();
    assert.equal(published, 0, 'a timed-out caller must never publish after its owner read resumes');
  } finally {
    release();
    await command.catch(() => undefined);
    await nextTurn();
    config.AGENT_HANDOFF_TIMEOUT_MS = oldTimeout;
  }
});

test('an outer timeout revokes a nested handoff before late remote publication', async (context) => {
  const oldTimeout = config.AGENT_HANDOFF_TIMEOUT_MS;
  config.AGENT_HANDOFF_TIMEOUT_MS = 480;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  installRedisStore(new Map<string, string>());
  const owner = { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' };
  let release!: () => void;
  const read = new Promise<string>((resolve) => { release = () => resolve(JSON.stringify(owner)); });
  let reads = 0, published = 0;
  context.mock.method(redis, 'get', () => {
    reads++;
    if (reads === 1 || reads === 3) return Promise.resolve(JSON.stringify({ ...owner, state: 'draining' }));
    if (reads === 2 || reads === 4) return Promise.resolve(JSON.stringify(owner));
    return read;
  });
  context.mock.method(redis, 'publish', async () => { published++; return 0; });
  const command = new AgentGateway().sendJsonRpc('target', 'tools/list', {});
  try {
    await nextTurn();
    now = 99.4;
    context.mock.timers.tick(100);
    await nextTurn();
    assert.equal(reads, 3);
    now = 199.4;
    context.mock.timers.tick(100);
    await nextTurn();
    assert.equal(reads, 5);
    const rejected = assert.rejects(command, AgentUnavailableError);
    now = 479.5;
    context.mock.timers.tick(280);
    await rejected;
    release();
    await nextTurn();
    assert.equal(published, 0, 'nested context must not publish after its outer caller times out');
  } finally {
    release();
    await command.catch(() => undefined);
    await nextTurn();
    config.AGENT_HANDOFF_TIMEOUT_MS = oldTimeout;
  }
});

test('accepted dispatch disarms all nested handoff watchdogs', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const owners = new Map<string, string>();
  installRedisStore(owners);
  setOwner(owners, 'target', { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' });
  let release!: () => void, dispatched = false, settled = false;
  const accepted = new Promise<string>((resolve) => { release = () => resolve('accepted-result'); });
  const command = waitForOwnerHandoff('target', 500, () => waitForOwnerHandoff('target', 500, async () => {
    beginAgentDispatch();
    dispatched = true;
    return accepted;
  }));
  const result = command.then((value) => { settled = true; return value; }, (error) => { settled = true; return error; });
  try {
    await nextTurn();
    now = 100;
    context.mock.timers.tick(100);
    await nextTurn();
    now = 200;
    context.mock.timers.tick(100);
    await nextTurn();
    assert.equal(dispatched, true);
    now = 501;
    context.mock.timers.tick(301);
    await nextTurn();
    assert.equal(settled, false, 'accepted nested command must survive its predispatch deadline');
    release();
    assert.equal(await result, 'accepted-result');
  } finally {
    release();
    await result;
    await nextTurn();
  }
});

test('a safe owner-draining response rearms the original handoff deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const owners = new Map<string, string>();
  installRedisStore(owners);
  setOwner(owners, 'target', { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' });
  let release!: () => void, settled = false;
  const stalled = new Promise<string>((resolve) => { release = () => resolve('unused'); });
  let reads = 0;
  context.mock.method(redis, 'get', async () => {
    reads++;
    if (reads === 1) return JSON.stringify({ instanceId: 'new', connectionId: 'new', workspaceId: 'workspace', updatedAt: 'now' });
    return stalled;
  });
  const command = waitForOwnerHandoff('target', 500, async () => {
    beginAgentDispatch();
    // A remote OWNER_DRAINING response proves the agent command was not sent.
    return waitForOwnerHandoff('target', 500, async () => 'unexpected-dispatch');
  });
  const result = command.then((value) => { settled = true; return value; }, (error) => { settled = true; return error; });
  try {
    await nextTurn();
    now = 100;
    context.mock.timers.tick(100);
    await nextTurn();
    now = 200;
    context.mock.timers.tick(100);
    await nextTurn();
    assert.equal(reads, 2, 'the second owner lookup must be stalled');
    now = 501;
    context.mock.timers.tick(301);
    await nextTurn();
    assert.equal(settled, true, 'safe rejection must rearm a bounded watchdog');
    assert.ok(await result instanceof AgentUnavailableError);
  } finally {
    release();
    await result;
    await nextTurn();
  }
});
