import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AgentGateway } from '../src/agent/ws-server.js';
import { AgentToolCallError } from '../src/agent/types.js';
import {
  getAgentOwner,
  handleAgentRpcMessageForTests,
  requestRemoteAgentRpc
} from '../src/services/control-plane-coordination.js';
import { runtime } from '../src/store/runtime.js';
import {
  FakeWebSocket,
  PublishedMessage,
  agentOwnerKey,
  connectAgent,
  installAgentRepoMocks,
  installRedisStore,
  sendAgentMessage,
  setOwner,
  setupControlPlaneCoordinationTest,
  teardownControlPlaneCoordinationTest,
  waitForSentMessage
} from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

describe('control-plane agent RPC routing', () => {
  it('returns agent unavailable when a remote owner has no RPC subscriber', async () => {
    const store = new Map<string, string>();
    installRedisStore(store, [], 0);

    const response = await requestRemoteAgentRpc(
      {
        instanceId: 'cp-test-b',
        connectionId: 'conn-2',
        workspaceId: 'workspace-1',
        updatedAt: '2026-05-19T00:00:00.000Z'
      },
      {
        clusterId: 'cluster-1',
        method: 'tools/list',
        params: {},
        timeoutMs: 100
      }
    );

    assert.equal(response.ok, false);
    assert.equal(response.code, 'AGENT_UNAVAILABLE');
  });

  it('sends JSON-RPC directly when this pod owns the connected agent', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-local', workspaceId: 'workspace-1', agentKey: 'agent-key-local' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-local', workspaceId: 'workspace-1', agentKey: 'agent-key-local' });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-local', 'tools/list', {});
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/list');
    assert.equal(command.method, 'tools/list');
    assert.match(String(command.id), /^cmd_/);

    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      id: command.id,
      result: { tools: [{ name: 'get_resource', description: 'Get resource' }] }
    });

    assert.deepEqual(await commandPromise, { tools: [{ name: 'get_resource', description: 'Get resource' }] });
  });

  it('preserves a stable tool operation ID on the local agent connection', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-stable', workspaceId: 'workspace-1', agentKey: 'agent-key-stable' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-stable', workspaceId: 'workspace-1', agentKey: 'agent-key-stable' });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-stable', 'tools/call', {}, 'tool_stable123');
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/call');
    assert.equal(command.id, 'tool_stable123');
    await sendAgentMessage(gateway, ws, { jsonrpc: '2.0', id: command.id, result: { success: true } });
    assert.deepEqual(await commandPromise, { success: true });
  });

  it('preserves sanitized timeout outcome data from the agent', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-error', workspaceId: 'workspace-1', agentKey: 'agent-key-error' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-error', workspaceId: 'workspace-1', agentKey: 'agent-key-error' });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-error', 'tools/call', {}, 'tool_timeout123');
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/call');
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      id: command.id,
      error: {
        code: -32003,
        message: "Tool 'scale_workload' timed out",
        data: { code: 'TOOL_TIMEOUT', outcome: 'unknown', operationId: 'operation-1' }
      }
    });

    await assert.rejects(commandPromise, (err: unknown) => {
      assert.ok(err instanceof AgentToolCallError);
      assert.equal(err.rpcCode, -32003);
      assert.deepEqual(err.data, { code: 'TOOL_TIMEOUT', outcome: 'unknown', operationId: 'operation-1' });
      return true;
    });
  });

  it('ignores JSON-RPC responses from non-owning agent connections', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-response-owner', workspaceId: 'workspace-1', agentKey: 'agent-key-response-owner' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, {
      clusterId: 'cluster-response-owner',
      workspaceId: 'workspace-1',
      agentKey: 'agent-key-response-owner'
    });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-response-owner', 'tools/list', {});
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/list');
    const staleWs = new FakeWebSocket();
    await sendAgentMessage(gateway, staleWs, {
      jsonrpc: '2.0',
      id: command.id,
      result: { tools: [{ name: 'stale_result', description: 'Wrong connection' }] }
    });
    assert.equal(runtime.agentCommands.size, 1);

    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      id: command.id,
      result: { tools: [{ name: 'fresh_result', description: 'Owning connection' }] }
    });

    assert.deepEqual(await commandPromise, { tools: [{ name: 'fresh_result', description: 'Owning connection' }] });
  });

  it('publishes remote JSON-RPC when another pod owns the connected agent', async () => {
    const store = new Map<string, string>();
    const published: PublishedMessage[] = [];
    installRedisStore(store, published, 0);
    setOwner(store, 'cluster-remote', {
      instanceId: 'cp-test-b',
      connectionId: 'conn-b',
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:00.000Z'
    });
    const gateway = new AgentGateway();

    await assert.rejects(gateway.sendJsonRpc('cluster-remote', 'tools/list', {}, 'tool_remote123'), /temporarily unavailable/);

    assert.equal(published.length, 1);
    assert.equal(published[0]!.channel, 'cp:agent:rpc:cp-test-b');
    const request = JSON.parse(published[0]!.message) as {
      clusterId: string;
      method: string;
      expectedConnectionId: string;
      replyChannel: string;
      agentRequestId: string;
    };
    assert.equal(request.clusterId, 'cluster-remote');
    assert.equal(request.method, 'tools/list');
    assert.equal(request.expectedConnectionId, 'conn-b');
    assert.equal(request.agentRequestId, 'tool_remote123');
    assert.match(request.replyChannel, /^cp:agent:rpc:response:cp-test-a:/);
  });

  it('returns agent unavailable when no owner record exists', async () => {
    installRedisStore(new Map<string, string>());
    const gateway = new AgentGateway();

    await assert.rejects(gateway.sendJsonRpc('cluster-missing', 'tools/list', {}), /temporarily unavailable/);
  });

  it('clears a stale local owner record and retries once before failing', async () => {
    const store = new Map<string, string>();
    const { evalCalls } = installRedisStore(store);
    setOwner(store, 'cluster-local-stale', {
      instanceId: 'cp-test-a',
      connectionId: 'missing-local-conn',
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:00.000Z'
    });
    const gateway = new AgentGateway();

    await assert.rejects(gateway.sendJsonRpc('cluster-local-stale', 'tools/list', {}), /temporarily unavailable/);

    assert.equal(store.has(agentOwnerKey('cluster-local-stale')), false);
    assert.equal(evalCalls.some((call) => call.kind === 'owner-delete' && call.key === agentOwnerKey('cluster-local-stale')), true);
  });

  it('executes a remote RPC request on the owner pod and publishes the response', async () => {
    const store = new Map<string, string>();
    const published: PublishedMessage[] = [];
    installRedisStore(store, published);
    installAgentRepoMocks([{ clusterId: 'cluster-owner', workspaceId: 'workspace-1', agentKey: 'agent-key-owner' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-owner', workspaceId: 'workspace-1', agentKey: 'agent-key-owner' });
    const owner = await getAgentOwner('cluster-owner');
    assert.ok(owner);

    const startIndex = ws.sent.length;
    const handlerPromise = handleAgentRpcMessageForTests(JSON.stringify({
      requestId: 'rpc-1',
      clusterId: 'cluster-owner',
      method: 'tools/list',
      params: {},
      replyChannel: 'reply-channel',
      originInstanceId: 'cp-test-b',
      expectedConnectionId: owner.connectionId,
      agentRequestId: 'tool_remote123'
    }));
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/list');
    assert.equal(command.id, 'tool_remote123');
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      id: command.id,
      result: { tools: [] }
    });
    await handlerPromise;

    assert.equal(published.at(-1)?.channel, 'reply-channel');
    assert.deepEqual(JSON.parse(published.at(-1)?.message || '{}'), {
      requestId: 'rpc-1',
      ok: true,
      result: { tools: [] }
    });
  });

  it('preserves sanitized agent errors across distributed RPC routing', async () => {
    const store = new Map<string, string>();
    const published: PublishedMessage[] = [];
    installRedisStore(store, published);
    installAgentRepoMocks([{ clusterId: 'cluster-owner', workspaceId: 'workspace-1', agentKey: 'agent-key-owner' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-owner', workspaceId: 'workspace-1', agentKey: 'agent-key-owner' });
    const owner = await getAgentOwner('cluster-owner');
    assert.ok(owner);

    const startIndex = ws.sent.length;
    const handlerPromise = handleAgentRpcMessageForTests(JSON.stringify({
      requestId: 'rpc-error', clusterId: 'cluster-owner', method: 'tools/call', params: {},
      replyChannel: 'reply-channel', originInstanceId: 'cp-test-b',
      expectedConnectionId: owner.connectionId, agentRequestId: 'tool_error123'
    }));
    const command = await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/call');
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0', id: command.id,
      error: {
        code: -32003, message: 'Tool timed out',
        data: { code: 'TOOL_TIMEOUT', outcome: 'unknown', operationId: 'operation-1' }
      }
    });
    await handlerPromise;

    assert.deepEqual(JSON.parse(published.at(-1)?.message || '{}'), {
      requestId: 'rpc-error', ok: false, code: 'COMMAND_TIMEOUT', error: 'Tool timed out',
      agentError: {
        rpcCode: -32003, message: 'Tool timed out',
        data: { code: 'TOOL_TIMEOUT', outcome: 'unknown', operationId: 'operation-1' }
      }
    });
  });
});

it('does not dispatch a new remote command once the owner is draining', async () => {
  const store = new Map<string, string>();
  const published: PublishedMessage[] = [];
  installRedisStore(store, published);
  installAgentRepoMocks([{ clusterId: 'cluster-drain', workspaceId: 'workspace-1', agentKey: 'agent-key' }]);
  const gateway = new AgentGateway();
  const ws = await connectAgent(gateway, { clusterId: 'cluster-drain', workspaceId: 'workspace-1', agentKey: 'agent-key' });
  const owner = await getAgentOwner('cluster-drain');
  await gateway.beginDrain();
  const sent = ws.sent.length;
  await handleAgentRpcMessageForTests(JSON.stringify({ requestId: 'draining-rpc', clusterId: 'cluster-drain', method: 'tools/call', params: {}, replyChannel: 'reply', originInstanceId: 'other', expectedConnectionId: owner?.connectionId }));
  assert.equal(ws.sent.length, sent);
  assert.equal(JSON.parse(published.at(-1)!.message).code, 'OWNER_DRAINING');
});

it('does not register a handshake that crosses drain during authentication', async () => {
  const store = new Map<string, string>();
  installRedisStore(store);
  installAgentRepoMocks([{ clusterId: 'handshake-race', workspaceId: 'workspace-1', agentKey: 'key' }]);
  const gateway = new AgentGateway();
  const { repo } = await import('../src/store/repository.js');
  const { mock } = await import('node:test');
  const lookup = repo.getTargetAgentRegistration;
  mock.method(repo, 'getTargetAgentRegistration', async (id: string) => {
    const result = await lookup(id);
    await gateway.beginDrain();
    return result;
  });
  const ws = new FakeWebSocket();
  await sendAgentMessage(gateway, ws, { jsonrpc: '2.0', id: 'handshake', method: 'lifecycle/handshake', params: {
    targetId: 'handshake-race', targetType: 'kubernetes', agentType: 'agentk', agentKey: 'key'
  } });
  assert.equal(await getAgentOwner('handshake-race'), undefined);
  assert.equal(ws.closeCode, 1012);
});

it('waits for a draining owner replacement before publishing a command', async () => {
  const { redis } = await import('../src/infra/redis.js');
  const { mock } = await import('node:test');
  const store = new Map<string, string>();
  installRedisStore(store);
  setOwner(store, 'handoff', { instanceId: 'old', connectionId: 'old-connection', workspaceId: 'workspace-1', updatedAt: 'now', state: 'draining' });
  const gateway = new AgentGateway();
  const commands: string[] = [];
  mock.method(redis, 'publish', async (channel: string) => { commands.push(channel); return 0; });
  const command = gateway.sendJsonRpc('handoff', 'tools/list', {});
  setTimeout(() => setOwner(store, 'handoff', { instanceId: 'new', connectionId: 'new-connection', workspaceId: 'workspace-1', updatedAt: 'now' }), 20);
  await assert.rejects(command, /temporarily unavailable/i);
  assert.deepEqual(commands, ['cp:agent:rpc:new']);
});

it('retains an incoming RPC until its response publication settles', async () => {
  const { serviceLifecycle } = await import('../src/services/service-lifecycle.js');
  const { redis } = await import('../src/infra/redis.js');
  const { mock } = await import('node:test');
  const { registerAgentRpcHandler } = await import('../src/services/control-plane-coordination.js');
  const store = new Map<string, string>();
  installRedisStore(store);
  let publishStarted!: () => void;
  const started = new Promise<void>((resolve) => { publishStarted = resolve; });
  let release!: () => void;
  const pending = new Promise<number>((resolve) => { release = () => resolve(1); });
  mock.method(redis, 'publish', () => { publishStarted(); return pending; });
  registerAgentRpcHandler(async (request) => ({ requestId: request.requestId, ok: true, result: 'done' }));
  const rpc = handleAgentRpcMessageForTests(JSON.stringify({ requestId: 'publishing', clusterId: 'cluster', method: 'tools/list', params: {}, replyChannel: 'reply', originInstanceId: 'other', expectedConnectionId: 'connection' }));
  await started;
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 20), false);
  release();
  await rpc;
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 100), true);
});

it('keeps an admitted command alive through drain and then reconnects that socket', async () => {
  const store = new Map<string, string>();
  installRedisStore(store);
  installAgentRepoMocks([{ clusterId: 'accepted-drain', workspaceId: 'workspace-1', agentKey: 'key' }]);
  const gateway = new AgentGateway();
  const ws = await connectAgent(gateway, { clusterId: 'accepted-drain', workspaceId: 'workspace-1', agentKey: 'key' });
  const command = gateway.sendJsonRpc('accepted-drain', 'tools/list', {}, 'accepted-operation');
  await waitForSentMessage(ws, 0, (message) => message.id === 'accepted-operation');
  await gateway.beginDrain();
  assert.equal(ws.closeCode, undefined);
  assert.equal((await getAgentOwner('accepted-drain'))?.state, 'draining');
  await sendAgentMessage(gateway, ws, { jsonrpc: '2.0', id: 'accepted-operation', result: { tools: [] } });
  assert.deepEqual(await command, { tools: [] });
  const { serviceLifecycle } = await import('../src/services/service-lifecycle.js');
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 500), true);
  assert.equal(ws.closeCode, 1012);
});

it('preserves known handoff through the closed-socket gap for a healthy caller', async () => {
  const { redis } = await import('../src/infra/redis.js');
  const { mock } = await import('node:test');
  const { serviceLifecycle } = await import('../src/services/service-lifecycle.js');
  const store = new Map<string, string>();
  installRedisStore(store);
  const { clusterUpdates } = installAgentRepoMocks([{ clusterId: 'handoff-gap', workspaceId: 'workspace-1', agentKey: 'key', status: 'online' }]);
  const oldGateway = new AgentGateway();
  const ws = await connectAgent(oldGateway, { clusterId: 'handoff-gap', workspaceId: 'workspace-1', agentKey: 'key' });
  await oldGateway.beginDrain();
  await serviceLifecycle.waitForIdle(performance.now() + 500);
  assert.equal(ws.closeCode, 1012);
  assert.ok(clusterUpdates.some((update) => update.patch.status === 'offline'));
  assert.equal((await getAgentOwner('handoff-gap'))?.state, 'draining');
  const healthy = new AgentGateway();
  const publications: string[] = [];
  mock.method(redis, 'publish', async (channel: string) => { publications.push(channel); return 0; });
  const command = healthy.sendJsonRpc('handoff-gap', 'tools/list', {}, 'stable-gap');
  setTimeout(() => setOwner(store, 'handoff-gap', { instanceId: 'new', connectionId: 'new', workspaceId: 'workspace-1', updatedAt: 'now' }), 20);
  await assert.rejects(command, /temporarily unavailable/);
  assert.deepEqual(publications, ['cp:agent:rpc:new']);
});

it('draining socket cleanup never marks a replacement owner offline', async () => {
  const { mock } = await import('node:test');
  const { repo } = await import('../src/store/repository.js');
  const { serviceLifecycle } = await import('../src/services/service-lifecycle.js');
  const store = new Map<string, string>();
  installRedisStore(store);
  const { clusterUpdates } = installAgentRepoMocks([{ clusterId: 'drain-fenced', workspaceId: 'workspace-1', agentKey: 'key', status: 'online' }]);
  const gateway = new AgentGateway();
  await connectAgent(gateway, { clusterId: 'drain-fenced', workspaceId: 'workspace-1', agentKey: 'key' });
  const getCluster = repo.getCluster;
  mock.method(repo, 'getCluster', async (id: string) => {
    setOwner(store, id, { instanceId: 'replacement', connectionId: 'new', workspaceId: 'workspace-1', updatedAt: 'now' });
    return getCluster(id);
  });
  await gateway.beginDrain();
  assert.equal(await serviceLifecycle.waitForIdle(performance.now() + 500), true);
  assert.equal((await getAgentOwner('drain-fenced'))?.connectionId, 'new');
  assert.equal(clusterUpdates.some((update) => update.patch.status === 'offline'), false);
});
