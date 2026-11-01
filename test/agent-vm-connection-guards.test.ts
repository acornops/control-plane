import { vmConnections } from '../src/store/repository-vm-connections.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import WebSocket from 'ws';
import { publishVirtualMachineConnection } from '../src/agent/vm-connection-lifecycle.js';
import { closeStaleAgentConnection, getAgentConnection, setAgentConnection } from '../src/agent/connections.js';
import type { AgentConnection } from '../src/agent/types.js';
import { AgentGateway } from '../src/agent/ws-server.js';
import { repo } from '../src/store/repository.js';
import { config } from '../src/config.js';
import { FakeWebSocket, installRedisStore, setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest } from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

test('a socket closed before claiming leaves the existing owner and persisted state alone', async () => {
  const existing = JSON.stringify({ instanceId: config.CONTROL_PLANE_INSTANCE_ID, connectionId: 'existing', workspaceId: 'workspace', updatedAt: 'now' });
  const owners = new Map([['cp:agent:owner:vm', existing]]); installRedisStore(owners);
  const persistence = mock.method(vmConnections, 'transition', async () => { throw new Error('closed socket reached persistence'); });
  const ws = new FakeWebSocket(); ws.close();
  await publishVirtualMachineConnection({
    connection: { clusterId: 'vm', targetType: 'virtual_machine', workspaceId: 'workspace', connectionId: 'closed', keyVersion: 1, ws: ws as unknown as WebSocket },
    mayConnect: () => false, publish: () => assert.fail('closed socket published')
  });
  assert.equal(owners.get('cp:agent:owner:vm'), existing);
  assert.equal(persistence.mock.callCount(), 0);
});

test('an ineligible attempt cannot close an already published VM replacement on its socket', async () => {
  installRedisStore(new Map());
  mock.method(vmConnections, 'transition', async (_id, input) => {
    assert.equal(await input.allow(), true);
    return { workspaceId: 'workspace', previousStatus: 'offline', status: input.status, updatedAt: 'now', connectionId: input.connectionId! };
  });
  const ws = new FakeWebSocket();
  const newer = { clusterId: 'vm', targetType: 'virtual_machine' as const, workspaceId: 'workspace', connectionId: 'newer', keyVersion: 1, ws: ws as unknown as WebSocket };
  await publishVirtualMachineConnection({ connection: newer, mayConnect: () => true, publish: () => setAgentConnection('vm', newer) });
  await publishVirtualMachineConnection({ connection: { ...newer, connectionId: 'ineligible' }, mayConnect: () => false, publish: () => assert.fail('ineligible attempt published') });
  assert.equal(getAgentConnection('vm'), newer); assert.equal(ws.readyState, WebSocket.OPEN);
  const distinct = new FakeWebSocket();
  await publishVirtualMachineConnection({ connection: { ...newer, connectionId: 'distinct', ws: distinct as unknown as WebSocket }, mayConnect: () => false, publish: () => assert.fail('ineligible attempt published') });
  assert.equal(distinct.readyState, WebSocket.CLOSED); assert.equal(ws.readyState, WebSocket.OPEN);
});

for (const accepted of [false, true]) test(`late heartbeat checks cannot close a same-socket replacement (credential accepted=${accepted})`, async () => {
  installRedisStore(new Map());
  mock.method(vmConnections, 'transition', async (_id, input) => await input.allow() ? {
    workspaceId: 'workspace', previousStatus: 'offline', status: input.status, updatedAt: 'now', connectionId: input.connectionId!
  } : null);
  const ws = new FakeWebSocket();
  const old = { clusterId: 'vm', targetType: 'virtual_machine' as const, workspaceId: 'workspace', connectionId: 'old', keyVersion: 1, credentialId: 'credential', ws: ws as unknown as WebSocket };
  const publish = (connection: typeof old) => publishVirtualMachineConnection({ connection, mayConnect: () => true, publish: () => setAgentConnection('vm', connection) });
  await publish(old);
  let checked!: () => void; const checkStarted = new Promise<void>((resolve) => { checked = resolve; });
  let release!: () => void; const checkRelease = new Promise<void>((resolve) => { release = resolve; });
  mock.method(repo.agentv, 'isAgentVCredentialAccepted', async () => { checked(); await checkRelease; return accepted; });
  const gateway = new AgentGateway() as unknown as {
    handleMessage(ws: WebSocket, raw: WebSocket.RawData, key: string, version: string): Promise<void>;
  };
  const heartbeat = gateway.handleMessage(old.ws, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'lifecycle/heartbeat' })), 'synthetic', 'agentv/test');
  await checkStarted;
  const newer = { ...old, connectionId: 'newer' }; await publish(newer);
  release(); await heartbeat;
  assert.equal(getAgentConnection('vm'), newer); assert.equal(ws.readyState, WebSocket.OPEN);
});

for (const path of ['stale', 'local'] as const) test(`shared ${path} closure still closes a distinct VM socket and retains Kubernetes behavior`, async () => {
  installRedisStore(new Map());
  mock.method(vmConnections, 'transition', async (_id, input) => input.status === 'online' && await input.allow() ? {
    workspaceId: 'workspace', previousStatus: 'offline', status: input.status, updatedAt: 'now', connectionId: input.connectionId!
  } : null);
  mock.method(repo, 'getCluster', async () => null);
  const gateway = new AgentGateway() as unknown as {
    closeLocalConnection(id: string, conn: AgentConnection, code: number, reason: string, pendingReason: string): Promise<void>;
  };
  const close = (conn: AgentConnection) => path === 'stale'
    ? closeStaleAgentConnection('vm', conn)
    : gateway.closeLocalConnection('vm', conn, 1012, 'old connection', 'old connection');
  const ws = new FakeWebSocket();
  const old: AgentConnection = { clusterId: 'vm', targetType: 'virtual_machine', workspaceId: 'workspace', connectionId: 'old', keyVersion: 1, ws: ws as unknown as WebSocket };
  const newer = { ...old, connectionId: 'newer' };
  await publishVirtualMachineConnection({ connection: newer, mayConnect: () => true, publish: () => setAgentConnection('vm', newer) });
  const distinct = new FakeWebSocket();
  await close({ ...old, ws: distinct as unknown as WebSocket });
  assert.equal(distinct.readyState, WebSocket.CLOSED); assert.equal(ws.readyState, WebSocket.OPEN);
  await close({ ...old, targetType: 'kubernetes' });
  assert.equal(ws.readyState, WebSocket.CLOSED, 'VM socket ownership must not change Kubernetes closure behavior');
});
