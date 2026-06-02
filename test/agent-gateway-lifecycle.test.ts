import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import { AgentGateway } from '../src/agent/ws-server.js';
import { runtime } from '../src/store/runtime.js';
import {
  agentOwnerKey,
  connectAgent,
  FakeWebSocket,
  installAgentRepoMocks,
  installRedisStore,
  parseLastSent,
  sendAgentMessage,
  setOwner,
  mutableConfig,
  setupControlPlaneCoordinationTest,
  sleep,
  teardownControlPlaneCoordinationTest,
  waitForSentMessage
} from './helpers/agent-gateway-fixtures.js';

beforeEach(setupControlPlaneCoordinationTest);
afterEach(teardownControlPlaneCoordinationTest);

class FakeUpgradeSocket extends Duplex {
  chunks: string[] = [];

  destroyedByGateway = false;

  _read(): void {
    // No-op test socket.
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    callback();
  }

  destroy(error?: Error): this {
    this.destroyedByGateway = true;
    return super.destroy(error);
  }
}

describe('agent gateway lifecycle', () => {
  it('rejects insecure production websocket upgrades before handshake', () => {
    mutableConfig.AGENT_WS_REQUIRE_SECURE_TRANSPORT = true;
    const gateway = new AgentGateway();
    const socket = new FakeUpgradeSocket();

    const handled = gateway.handleUpgrade({
      url: '/api/v1/agent/connect',
      headers: {
        'x-forwarded-proto': 'http'
      },
      socket
    } as unknown as IncomingMessage, socket, Buffer.alloc(0));

    assert.equal(handled, true);
    assert.equal(socket.destroyedByGateway, true);
    assert.match(socket.chunks.join(''), /400 Secure WebSocket required/);
  });

  it('rejects local commands immediately when the owning agent connection closes', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-close', workspaceId: 'workspace-1', agentKey: 'agent-key-close' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-close', workspaceId: 'workspace-1', agentKey: 'agent-key-close' });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-close', 'tools/list', {});
    await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/list');
    assert.equal(runtime.agentCommands.size, 1);
    ws.close(1006, 'closed');

    await assert.rejects(commandPromise, /Agent connection closed/);
    assert.equal(runtime.agentCommands.size, 0);
  });

  it('gracefully shuts down connected agents and rejects pending commands', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([{ clusterId: 'cluster-shutdown', workspaceId: 'workspace-1', agentKey: 'agent-key-shutdown' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-shutdown', workspaceId: 'workspace-1', agentKey: 'agent-key-shutdown' });

    const startIndex = ws.sent.length;
    const commandPromise = gateway.sendJsonRpc('cluster-shutdown', 'tools/list', {});
    await waitForSentMessage(ws, startIndex, (message) => message.method === 'tools/list');
    assert.equal(runtime.agentCommands.size, 1);

    await gateway.shutdown(10);

    await assert.rejects(commandPromise, /Agent connection closed/);
    assert.equal(runtime.agentCommands.size, 0);
    assert.equal(ws.closeCode, 1001);
    assert.equal(store.has(agentOwnerKey('cluster-shutdown')), false);
  });

  it('stale connection cleanup rejects only commands owned by the stale connection', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([
      { clusterId: 'cluster-stale-1', workspaceId: 'workspace-1', agentKey: 'agent-key-stale-1' },
      { clusterId: 'cluster-stale-2', workspaceId: 'workspace-1', agentKey: 'agent-key-stale-2' }
    ]);
    const gateway = new AgentGateway();
    const ws1 = await connectAgent(gateway, { clusterId: 'cluster-stale-1', workspaceId: 'workspace-1', agentKey: 'agent-key-stale-1' });
    const ws2 = await connectAgent(gateway, { clusterId: 'cluster-stale-2', workspaceId: 'workspace-1', agentKey: 'agent-key-stale-2' });

    const ws1StartIndex = ws1.sent.length;
    const ws2StartIndex = ws2.sent.length;
    const command1 = gateway.sendJsonRpc('cluster-stale-1', 'tools/list', {});
    const command2 = gateway.sendJsonRpc('cluster-stale-2', 'tools/list', {});
    await waitForSentMessage(ws1, ws1StartIndex, (message) => message.method === 'tools/list');
    await waitForSentMessage(ws2, ws2StartIndex, (message) => message.method === 'tools/list');
    ws1.close(1006, 'closed');

    await assert.rejects(command1, /Agent connection closed/);
    const command = parseLastSent(ws2);
    await sendAgentMessage(gateway, ws2, {
      jsonrpc: '2.0',
      id: command.id,
      result: { tools: [] }
    });
    assert.deepEqual(await command2, { tools: [] });
  });

  it('does not mark a cluster offline when a closing connection is no longer the Redis owner', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    const repoState = installAgentRepoMocks([{ clusterId: 'cluster-reconnect', workspaceId: 'workspace-1', agentKey: 'agent-key-reconnect' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-reconnect', workspaceId: 'workspace-1', agentKey: 'agent-key-reconnect' });
    setOwner(store, 'cluster-reconnect', {
      instanceId: 'cp-test-b',
      connectionId: 'newer-connection',
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:00.000Z'
    });

    ws.emit('close');
    await sleep(0);

    assert.equal(repoState.clusterUpdates.some((update) => update.clusterId === 'cluster-reconnect' && update.patch.status === 'offline'), false);
  });

  it('does not mark a reconnected cluster offline after clearing the old owner', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    const repoState = installAgentRepoMocks([{ clusterId: 'cluster-race', workspaceId: 'workspace-1', agentKey: 'agent-key-race' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-race', workspaceId: 'workspace-1', agentKey: 'agent-key-race' });
    const oldOwner = JSON.parse(store.get(agentOwnerKey('cluster-race')) || '{}') as { connectionId: string };

    setOwner(store, 'cluster-race', {
      instanceId: 'cp-test-a',
      connectionId: oldOwner.connectionId,
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:00.000Z'
    });
    ws.emit('close');
    setOwner(store, 'cluster-race', {
      instanceId: 'cp-test-b',
      connectionId: 'newer-connection',
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:01.000Z'
    });
    await sleep(0);

    assert.equal(repoState.clusterUpdates.some((update) => update.clusterId === 'cluster-race' && update.patch.status === 'offline'), false);
  });

  it('closes stale duplicate connections before processing heartbeat or snapshot state', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    const repoState = installAgentRepoMocks([{ clusterId: 'cluster-duplicate', workspaceId: 'workspace-1', agentKey: 'agent-key-duplicate' }]);
    const gateway = new AgentGateway();
    const ws = await connectAgent(gateway, { clusterId: 'cluster-duplicate', workspaceId: 'workspace-1', agentKey: 'agent-key-duplicate' });
    const seenAfterHandshake = repoState.agentSeenUpdates.length;
    setOwner(store, 'cluster-duplicate', {
      instanceId: 'cp-test-b',
      connectionId: 'newer-connection',
      workspaceId: 'workspace-1',
      updatedAt: '2026-05-19T00:00:00.000Z'
    });

    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      method: 'lifecycle/heartbeat',
      params: {}
    });
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      method: 'notify/snapshot',
      params: {
        timestamp: '2026-05-19T00:02:00.000Z',
        data: { resources: [] }
      }
    });

    assert.equal(ws.closeCode, 1012);
    assert.equal(repoState.agentSeenUpdates.length, seenAfterHandshake);
    assert.equal(repoState.snapshots.length, 0);
  });

  it('rejects compressed pre-auth handshakes before decompression', async () => {
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
        'x-agent-key': 'agent-key',
        'x-agent-version': 'agent-test'
      },
      socket: { remoteAddress: '203.0.113.10' }
    } as never);

    await internal.handleMessage(
      ws as unknown as WebSocket,
      gzipSync(Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-compressed',
        method: 'lifecycle/handshake',
        params: {
          targetId: 'cluster-1',
          targetType: 'kubernetes',
          agentType: 'k8s_agent',
          agentKey: 'agent-key'
        }
      }))),
      'agent-key',
      'agent-test',
      '203.0.113.10'
    );

    assert.equal(ws.closeCode, 1008);
    assert.equal(ws.sent.length, 0);
  });

  it('requires authentication before non-handshake messages', async () => {
    const gateway = new AgentGateway();
    const ws = new FakeWebSocket();
    await sendAgentMessage(gateway, ws, {
      jsonrpc: '2.0',
      method: 'lifecycle/heartbeat',
      params: {}
    });

    assert.equal(ws.closeCode, 1008);
  });

  it('uses the claimed target registration for handshake verification', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([
      { clusterId: 'cluster-claimed', workspaceId: 'workspace-1', agentKey: 'agent-key-claimed' },
      { clusterId: 'cluster-other', workspaceId: 'workspace-1', agentKey: 'agent-key-other' }
    ]);
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
        'x-agent-key': 'agent-key-other',
        'x-agent-version': 'agent-test'
      },
      socket: { remoteAddress: '203.0.113.11' }
    } as never);

    await internal.handleMessage(
      ws as unknown as WebSocket,
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-mismatch',
        method: 'lifecycle/handshake',
        params: {
          targetId: 'cluster-claimed',
          agentKey: 'agent-key-other',
          targetType: 'kubernetes',
          agentType: 'k8s_agent',
          supportedCapabilities: ['read']
        }
      })),
      'agent-key-other',
      'agent-test',
      '203.0.113.11'
    );

    const response = parseLastSent(ws);
    assert.equal((response.error as { code?: number } | undefined)?.code, 401);
    assert.equal(ws.closeCode, 1008);
    assert.equal(store.has(agentOwnerKey('cluster-other')), false);
  });

  it('rejects handshakes that omit the target-aware scope', async () => {
    const store = new Map<string, string>();
    installRedisStore(store);
    installAgentRepoMocks([
      { clusterId: 'cluster-claimed', workspaceId: 'workspace-1', agentKey: 'agent-key-claimed' },
      { clusterId: 'cluster-other', workspaceId: 'workspace-1', agentKey: 'agent-key-other' }
    ]);
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
        'x-agent-key': 'agent-key-claimed',
        'x-agent-version': 'agent-test'
      },
      socket: { remoteAddress: '203.0.113.12' }
    } as never);

    await internal.handleMessage(
      ws as unknown as WebSocket,
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 'handshake-missing-target',
        method: 'lifecycle/handshake',
        params: {
          agentKey: 'agent-key-claimed',
          targetType: 'kubernetes',
          agentType: 'k8s_agent',
          supportedCapabilities: ['read']
        }
      })),
      'agent-key-claimed',
      'agent-test',
      '203.0.113.12'
    );

    const response = parseLastSent(ws);
    assert.equal((response.error as { code?: number } | undefined)?.code, 401);
    assert.equal(ws.closeCode, 1008);
    assert.equal(store.has(agentOwnerKey('cluster-claimed')), false);
  });
});
