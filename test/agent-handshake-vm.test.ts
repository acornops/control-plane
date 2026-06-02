import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { webhooks } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { hashSecret } from '../src/utils/crypto.js';
import {
  agentOwnerKey,
  FakeWebSocket,
  installRedisStore,
  parseLastSent,
  setupControlPlaneCoordinationTest,
  teardownControlPlaneCoordinationTest
} from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

function createVm(status: 'online' | 'offline') {
  return {
    id: 'vm-1',
    workspaceId: 'workspace-1',
    name: 'vm',
    status,
    hostname: 'vm.example.test',
    osFamily: 'linux' as const,
    serviceManager: 'systemd' as const,
    allowedLogSources: ['journald'],
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: status === 'online' ? '2026-05-19T00:01:00.000Z' : '2026-05-19T00:00:00.000Z'
  };
}

describe('VM agent handshake', () => {
  it('returns capability-driven write policy for VM handshakes', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    const registration = {
      targetId: 'vm-1',
      targetType: 'virtual_machine' as const,
      workspaceId: 'workspace-1',
      agentKeyHash: hashSecret('agent-key-vm'),
      keyVersion: 1,
      capabilities: ['read']
    };
    const seenUpdates: Array<Record<string, unknown>> = [];
    mock.method(repo, 'getTargetAgentRegistration', async (targetId: string) =>
      targetId === registration.targetId ? registration : null
    );
    mock.method(repo, 'upsertTargetAgentRegistration', async (next: typeof registration) => {
      registration.capabilities = next.capabilities;
    });
    mock.method(repo, 'updateTargetAgentSeen', async (_targetId: string, patch: Record<string, unknown>) => {
      seenUpdates.push(patch);
    });
    mock.method(repo, 'getVirtualMachine', async (targetId: string) => targetId === 'vm-1' ? createVm('offline') : null);
    mock.method(repo, 'updateVirtualMachine', async (targetId: string) => targetId === 'vm-1' ? createVm('online') : null);
    mock.method(webhooks, 'emit', () => undefined);

    const gateway = new AgentGateway();
    const ws = new FakeWebSocket();
    const internal = gateway as unknown as {
      handleConnection(ws: WebSocket, request: never): void;
      handleMessage(
        ws: WebSocket,
        raw: WebSocket.RawData,
        agentKeyHeader: string,
        agentVersion: string,
        remoteAddress?: string
      ): Promise<void>;
    };
    internal.handleConnection(ws as unknown as WebSocket, {
      headers: {
        'x-agent-key': 'agent-key-vm',
        'x-agent-version': 'vm-agent-test'
      },
      socket: { remoteAddress: '203.0.113.13' }
    } as never);

    await internal.handleMessage(
      ws as unknown as WebSocket,
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-vm',
        method: 'lifecycle/handshake',
        params: {
          targetId: 'vm-1',
          targetType: 'virtual_machine',
          agentType: 'vm_agent',
          agentKey: 'agent-key-vm',
          supportedCapabilities: ['read', 'write', 'logs']
        }
      })),
      'agent-key-vm',
      'vm-agent-test',
      '203.0.113.13'
    );

    const response = parseLastSent(ws) as {
      result?: {
        targetId?: string;
        targetType?: string;
        sessionPolicy?: { allowedTools?: string[]; writeEnabled?: boolean };
        config?: { namespaceScope?: unknown };
      };
    };
    assert.equal(response.result?.targetId, 'vm-1');
    assert.equal(response.result?.targetType, 'virtual_machine');
    assert.equal(response.result?.sessionPolicy?.writeEnabled, true);
    assert(response.result?.sessionPolicy?.allowedTools?.includes('get_logs'));
    assert.equal(response.result?.config?.namespaceScope, undefined);
    assert.deepEqual(registration.capabilities, ['read', 'write', 'logs']);
    assert.equal(seenUpdates.length >= 2, true);
    assert.equal(store.has(agentOwnerKey('vm-1')), true);
  });
});
