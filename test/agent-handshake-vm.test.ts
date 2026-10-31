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

describe('AgentV handshake', () => {
  it('verifies a legacy pending Linux credential with optional helper and tool fields omitted', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    mock.method(repo.agentv, 'authenticateAgentVCredential', async () => ({
      credential: { id: 'pending-1', targetId: 'vm-1', enrollmentId: 'enrollment-1', keyHash: 'hash', generation: 1, state: 'pending' as const },
      workspaceId: 'workspace-1', provisional: true
    }));
    const ws = new FakeWebSocket();
    await (new AgentGateway() as unknown as {
      handleMessage(ws: WebSocket, raw: WebSocket.RawData, key: string, version: string, remote?: string): Promise<void>;
    }).handleMessage(ws as unknown as WebSocket, Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 'pending', method: 'lifecycle/handshake', params: {
        targetId: 'vm-1', targetType: 'virtual_machine', agentType: 'agentv', agentKey: 'pending-key',
        hostFeatures: { osFamily: 'linux', serviceManager: 'systemd' }
      }
    })), 'pending-key', 'agentv/test', '203.0.113.13');
    const response = parseLastSent(ws) as { result?: { provisional?: boolean; sessionPolicy?: { allowedTools?: string[] } } };
    assert.equal(response.result?.provisional, true);
    assert.deepEqual(response.result?.sessionPolicy?.allowedTools, []);
    assert.equal(store.has(agentOwnerKey('vm-1')), false);
  });

  it('requires the released Linux/systemd identity before verifying credentials', async () => {
    const authenticate = mock.method(repo.agentv, 'authenticateAgentVCredential', async () => null);
    for (const hostFeatures of [undefined, { osFamily: 'linux' }, { serviceManager: 'systemd' }]) {
      const ws = new FakeWebSocket();
      await (new AgentGateway() as unknown as {
        handleMessage(ws: WebSocket, raw: WebSocket.RawData, key: string, version: string): Promise<void>;
      }).handleMessage(ws as unknown as WebSocket, Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: 'missing-runtime', method: 'lifecycle/handshake', params: {
          targetId: 'vm-1', targetType: 'virtual_machine', agentType: 'agentv', agentKey: 'pending-key', hostFeatures
        }
      })), 'pending-key', 'agentv/0.0.1-experimental.14');

      const response = parseLastSent(ws) as { error?: { code?: number } };
      assert.equal(response.error?.code, 401);
      assert.equal(ws.closeCode, 1008);
    }
    assert.equal(authenticate.mock.callCount(), 0);
  });

  it('accepts omitted optional helper fields with capability-driven VM write policy', async () => {
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
    mock.method(repo.agentv, 'authenticateAgentVCredential', async (targetId: string, key: string) =>
      targetId === registration.targetId && key === 'agent-key-vm'
        ? { credential: { id: 'credential-1', targetId, enrollmentId: 'enrollment-1', keyHash: registration.agentKeyHash, generation: 1, state: 'active' as const }, workspaceId: 'workspace-1', provisional: false }
        : null
    );
    mock.method(repo, 'updateTargetAgentCapabilities', async (_targetId: string, capabilities: string[]) => {
      registration.capabilities = capabilities;
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
        connectorVersion: string,
        remoteAddress?: string
      ): Promise<void>;
    };
    internal.handleConnection(ws as unknown as WebSocket, {
      headers: {
        'x-agent-key': 'agent-key-vm',
        'x-connector-version': 'agentv/test'
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
          agentType: 'agentv',
          agentKey: 'agent-key-vm',
          supportedCapabilities: ['read', 'write', 'restart_service', 'logs'],
          hostFeatures: {
            osFamily: 'linux',
            serviceManager: 'systemd'
          },
          advertisedTools: [
            { name: 'query_logs', capability: 'read' },
            { name: 'restart_service', capability: 'write' }
          ]
        }
      })),
      'agent-key-vm',
      'agentv/test',
      '203.0.113.13'
    );

    const response = parseLastSent(ws) as {
      result?: {
        targetId?: string;
        targetType?: string;
        sessionPolicy?: { allowedTools?: string[]; writeEnabled?: boolean };
        config?: { namespaceScope?: unknown; maxSnapshotBytes?: number };
      };
    };
    assert.equal(response.result?.targetId, 'vm-1');
    assert.equal(response.result?.targetType, 'virtual_machine');
    assert.equal(response.result?.sessionPolicy?.writeEnabled, true);
    assert(response.result?.sessionPolicy?.allowedTools?.includes('query_logs'));
    assert(response.result?.sessionPolicy?.allowedTools?.includes('restart_service'));
    assert.equal(response.result?.config?.namespaceScope, undefined);
    assert.equal(response.result?.config?.maxSnapshotBytes, 1024 * 1024);
    assert.deepEqual(registration.capabilities, ['read', 'write', 'restart_service', 'logs']);
    assert.equal(seenUpdates.length >= 2, true);
    assert.equal(seenUpdates[0]?.lastAuthenticatedKeyVersion, 1);
    assert.equal(store.has(agentOwnerKey('vm-1')), true);
  });

  it('keeps a still-valid grace credential connected despite the active registration generation', async () => {
    mock.method(repo.agentv, 'isAgentVCredentialAccepted', async (targetId: string, credentialId: string) =>
      targetId === 'vm-1' && credentialId === 'credential-grace'
    );
    mock.method(repo, 'getTargetAgentRegistration', async () => ({
      targetId: 'vm-1', targetType: 'virtual_machine' as const, workspaceId: 'workspace-1',
      agentKeyHash: 'active-hash', keyVersion: 2
    }));
    const gateway = new AgentGateway() as unknown as {
      ensureAgentConnectionCurrent(connection: Record<string, unknown>): Promise<boolean>;
    };
    const accepted = await gateway.ensureAgentConnectionCurrent({
      clusterId: 'vm-1', targetType: 'virtual_machine', credentialId: 'credential-grace', keyVersion: 1
    });
    assert.equal(accepted, true);
  });

  it('does not let a grace credential reclaim ownership after the active generation connected', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    mock.method(repo.agentv, 'authenticateAgentVCredential', async () => ({
      credential: {
        id: 'credential-grace', targetId: 'vm-1', enrollmentId: 'enrollment-1',
        keyHash: 'grace-hash', generation: 1, state: 'grace' as const
      },
      workspaceId: 'workspace-1', provisional: false
    }));
    mock.method(repo, 'getTargetAgentRegistration', async () => ({
      targetId: 'vm-1', targetType: 'virtual_machine' as const, workspaceId: 'workspace-1',
      agentKeyHash: 'active-hash', keyVersion: 2, lastAuthenticatedKeyVersion: 2
    }));

    const ws = new FakeWebSocket();
    await (new AgentGateway() as unknown as {
      handleMessage(ws: WebSocket, raw: WebSocket.RawData, key: string, version: string, remote?: string): Promise<void>;
    }).handleMessage(ws as unknown as WebSocket, Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 'grace', method: 'lifecycle/handshake', params: {
        targetId: 'vm-1', targetType: 'virtual_machine', agentType: 'agentv', agentKey: 'grace-key',
        hostFeatures: { osFamily: 'linux', serviceManager: 'systemd', helperReachable: false, restartServices: [] }
      }
    })), 'grace-key', 'agentv/test', '203.0.113.13');

    const response = parseLastSent(ws) as { error?: { code?: number } };
    assert.equal(response.error?.code, 401);
    assert.equal(store.has(agentOwnerKey('vm-1')), false);
  });
});

it('suppresses Windows write capability and unreviewed tools at handshake', async () => {
  const { config } = await import('../src/config.js');
  const previous = config.AGENTV_WINDOWS_ENABLED;
  config.AGENTV_WINDOWS_ENABLED = true;
  try {
    installRedisStore(new Map());
    mock.method(repo.agentv, 'authenticateAgentVCredential', async (_id, _key, runtime) => {
      assert.deepEqual(runtime, { osFamily: 'windows', serviceManager: 'scm' });
      return { credential: { id: 'active', targetId: 'vm-1', enrollmentId: 'enrollment', keyHash: 'hash', generation: 1, state: 'active' as const }, workspaceId: 'workspace-1', provisional: false };
    });
    mock.method(repo, 'getTargetAgentRegistration', async () => ({ targetId: 'vm-1', targetType: 'virtual_machine' as const, workspaceId: 'workspace-1', agentKeyHash: 'hash', keyVersion: 1, capabilities: [] }));
    mock.method(repo, 'getVirtualMachine', async () => ({ ...createVm('offline'), osFamily: 'windows', serviceManager: 'scm' }));
    mock.method(repo, 'updateVirtualMachine', async () => ({ ...createVm('online'), osFamily: 'windows', serviceManager: 'scm' }));
    mock.method(repo, 'updateTargetAgentCapabilities', async (_id, capabilities) => { assert.deepEqual(capabilities, ['read', 'windows', 'scm']); });
    mock.method(repo, 'updateTargetAgentSeen', async () => undefined);
    mock.method(webhooks, 'emit', () => undefined);
    const ws = new FakeWebSocket();
    await (new AgentGateway() as unknown as { handleMessage(ws: WebSocket, raw: WebSocket.RawData, key: string, version: string): Promise<void> }).handleMessage(ws as unknown as WebSocket, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'windows', method: 'lifecycle/handshake', params: {
      targetId: 'vm-1', targetType: 'virtual_machine', agentType: 'agentv', hostFeatures: { osFamily: 'windows', serviceManager: 'scm' }, supportedCapabilities: ['read', 'write', 'linux', 'systemd', 'windows', 'scm'],
      advertisedTools: [{ name: 'query_logs', capability: 'read' }, { name: 'get_service', capability: 'write' }, { name: 'restart_service', capability: 'read' }, { name: 'arbitrary_shell', capability: 'read' }]
    } })), 'key', 'agentv/test');
    const result = parseLastSent(ws) as { result: { sessionPolicy: { allowedTools: string[]; writeEnabled: boolean } } };
    assert.deepEqual(result.result.sessionPolicy, { allowedTools: ['query_logs'], writeEnabled: false });
  } finally { config.AGENTV_WINDOWS_ENABLED = previous; }
});
