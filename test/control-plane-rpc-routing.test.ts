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

    await assert.rejects(gateway.sendJsonRpc('cluster-remote', 'tools/list', {}, 'tool_remote123'), /Agent is not connected/);

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

    await assert.rejects(gateway.sendJsonRpc('cluster-missing', 'tools/list', {}), /Agent is not connected/);
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

    await assert.rejects(gateway.sendJsonRpc('cluster-local-stale', 'tools/list', {}), /Agent is not connected/);

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
