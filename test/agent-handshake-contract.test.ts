import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import { handleAgentHandshake } from '../src/agent/handshake.js';
import { config } from '../src/config.js';
import {
  FakeWebSocket, installAgentRepoMocks, installRedisStore, parseLastSent,
  setupControlPlaneCoordinationTest, teardownControlPlaneCoordinationTest
} from './helpers/agent-gateway-fixtures.js';

describe('AgentK handshake contract', () => {
  it('rejects the unsupported k8s_agent type before key lookup', async () => {
    const ws = new FakeWebSocket();

    await handleAgentHandshake({
      ws: ws as unknown as WebSocket,
      requestId: 'unsupported-agent-type',
      params: {
        targetId: 'cluster-1',
        targetType: 'kubernetes',
        agentType: 'k8s_agent',
        agentKey: 'agent-key'
      },
      agentKeyHeader: 'agent-key',
      connectorVersion: 'agentk/test'
    });

    assert.equal(ws.closeCode, 1008);
    assert.equal((parseLastSent(ws) as { error?: { message?: string } }).error?.message, 'Invalid agent key');
  });

  for (const connectorVersion of ['', 'agentv/1.2.3', 'agentk/1.2.3/extra']) {
    it(`rejects invalid AgentK connector version ${JSON.stringify(connectorVersion)}`, async () => {
      const ws = new FakeWebSocket();

      await handleAgentHandshake({
        ws: ws as unknown as WebSocket,
        requestId: 'invalid-connector-version',
        params: {
          targetId: 'cluster-1',
          targetType: 'kubernetes',
          agentType: 'agentk',
          agentKey: 'agent-key'
        },
        agentKeyHeader: 'agent-key',
        connectorVersion
      });

      assert.equal(ws.closeCode, 1008);
      assert.equal((parseLastSent(ws) as { error?: { message?: string } }).error?.message, 'Invalid agent key');
    });
  }
});

describe('AgentK negotiated snapshot budget', () => {
  const originalMaxPayload = config.AGENT_WS_MAX_PAYLOAD_BYTES;
  const originalMaxDecoded = config.AGENT_WS_MAX_DECODED_BYTES;
  beforeEach(setupControlPlaneCoordinationTest);
  afterEach(() => {
    config.AGENT_WS_MAX_PAYLOAD_BYTES = originalMaxPayload;
    config.AGENT_WS_MAX_DECODED_BYTES = originalMaxDecoded;
    teardownControlPlaneCoordinationTest();
  });

  for (const maxPayloadBytes of [3 * 1024 * 1024, 2 * 1024 * 1024 + 65536, 5 * 1024 * 1024]) {
    it(`never advertises more than the ${maxPayloadBytes}-byte receiver limit`, async () => {
      config.AGENT_WS_MAX_PAYLOAD_BYTES = maxPayloadBytes;
      config.AGENT_WS_MAX_DECODED_BYTES = maxPayloadBytes + 1024 * 1024;
      installRedisStore(new Map());
      installAgentRepoMocks([{ clusterId: 'cluster-1', workspaceId: 'workspace-1', agentKey: 'agent-key' }]);
      const ws = new FakeWebSocket();
      await handleAgentHandshake({
        ws: ws as unknown as WebSocket, requestId: 'handshake-1',
        params: {
          targetId: 'cluster-1', targetType: 'kubernetes', agentType: 'agentk',
          agentKey: 'agent-key', supportedCapabilities: ['read'], advertisedTools: []
        },
        agentKeyHeader: 'agent-key', connectorVersion: 'agentk/test'
      });
      const response = parseLastSent(ws) as { result?: { config?: { maxSnapshotBytes?: number; maxDecodedSnapshotBytes?: number } } };
      assert.equal(response.result?.config?.maxSnapshotBytes, maxPayloadBytes);
      assert.equal(response.result?.config?.maxDecodedSnapshotBytes, maxPayloadBytes + 1024 * 1024);
    });
  }
});
