import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { handleAgentHandshake } from '../src/agent/handshake.js';
import { getAgentConnection, setAgentConnection } from '../src/agent/connections.js';
import { repo } from '../src/store/repository.js';
import { connectAgent, FakeWebSocket, installAgentRepoMocks, installRedisStore, sendAgentMessage,
  setOwner, mutableConfig, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);
const agent = { clusterId: 'heartbeat', workspaceId: 'workspace-1', agentKey: 'synthetic' };

test('heartbeat persists its receipt time and exact authenticated connection identity', async () => {
  installRedisStore(new Map());
  const state = installAgentRepoMocks([agent]);
  const gateway = new AgentGateway();
  const ws = await connectAgent(gateway, agent);
  const receivedAt = new Date('2026-11-02T01:00:00Z');
  mock.timers.enable({ apis: ['Date'], now: receivedAt });
  const read = repo.getTargetAgentRegistration;
  mock.method(repo, 'getTargetAgentRegistration', async (id) => {
    mock.timers.tick(5000);
    return read(id);
  });
  await sendAgentMessage(gateway, ws, { jsonrpc: '2.0', method: 'lifecycle/heartbeat', params: { timestamp: '2099-01-01T00:00:00Z' } });
  assert.deepEqual(state.agentSeenUpdates.at(-1)?.patch, {
    lastSeenAt: receivedAt.toISOString(), lastHeartbeatAt: receivedAt.toISOString(),
    expectedConnectionId: getAgentConnection(agent.clusterId)!.connectionId, lastAuthenticatedKeyVersion: 1
  });
});

test('an authenticated but unpublished handshake cannot refresh an existing heartbeat', async () => {
  installRedisStore(new Map());
  const state = installAgentRepoMocks([agent]);
  mock.method(repo, 'getCluster', async () => null);
  const ws = new FakeWebSocket();
  await handleAgentHandshake({ ws: ws as unknown as WebSocket, requestId: 'missing',
    agentKeyHeader: agent.agentKey, connectorVersion: 'agentk/test', params: {
      targetId: agent.clusterId, targetType: 'kubernetes', agentType: 'agentk'
    } });
  assert.equal(state.agentSeenUpdates.some(({ patch }) => patch.lastHeartbeatAt !== undefined), false);
  assert.equal(getAgentConnection(agent.clusterId), undefined);
});

test('a heartbeat awaiting decoding cannot be attributed to a replacement on the same socket', async () => {
  const owners = new Map<string, string>();
  installRedisStore(owners);
  const state = installAgentRepoMocks([agent]);
  const gateway = new AgentGateway();
  const ws = await connectAgent(gateway, agent);
  const before = state.agentSeenUpdates.length;
  const pending = sendAgentMessage(gateway, ws, { jsonrpc: '2.0', method: 'lifecycle/heartbeat', params: {} });
  const replacement = { ...getAgentConnection(agent.clusterId)!, connectionId: 'replacement' };
  setAgentConnection(agent.clusterId, replacement);
  setOwner(owners, agent.clusterId, { instanceId: mutableConfig.CONTROL_PLANE_INSTANCE_ID,
    connectionId: replacement.connectionId, workspaceId: agent.workspaceId, updatedAt: new Date().toISOString() });
  await pending;
  assert.equal(state.agentSeenUpdates.length, before);
  assert.equal(ws.readyState, WebSocket.OPEN);
  await sendAgentMessage(gateway, ws, { jsonrpc: '2.0', method: 'lifecycle/heartbeat', params: {} });
  assert.equal(state.agentSeenUpdates.at(-1)?.patch.expectedConnectionId, 'replacement');
});

test('a successful Kubernetes handshake initializes heartbeat together with its identity', async () => {
  installRedisStore(new Map());
  const state = installAgentRepoMocks([agent]);
  await connectAgent(new AgentGateway(), agent);
  const writes = state.agentSeenUpdates.filter(({ patch }) => patch.lastHeartbeatAt !== undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch.lastConnectionId, getAgentConnection(agent.clusterId)!.connectionId);
});
