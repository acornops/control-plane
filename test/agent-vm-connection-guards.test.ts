import { vmConnections } from '../src/store/repository-vm-connections.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import WebSocket from 'ws';
import { publishVirtualMachineConnection } from '../src/agent/vm-connection-lifecycle.js';
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
