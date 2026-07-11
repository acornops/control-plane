import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket from 'ws';
import { handleAgentHandshake } from '../src/agent/handshake.js';
import { FakeWebSocket, parseLastSent } from './helpers/agent-gateway-fixtures.js';

describe('AgentK handshake contract', () => {
  it('rejects the legacy k8s_agent type before key lookup', async () => {
    const ws = new FakeWebSocket();

    await handleAgentHandshake({
      ws: ws as unknown as WebSocket,
      requestId: 'legacy-agent-type',
      params: {
        targetId: 'cluster-1',
        targetType: 'kubernetes',
        agentType: 'k8s_agent',
        agentKey: 'agent-key'
      },
      agentKeyHeader: 'agent-key',
      agentVersion: 'test'
    });

    assert.equal(ws.closeCode, 1008);
    assert.equal((parseLastSent(ws) as { error?: { message?: string } }).error?.message, 'Invalid agent key');
  });
});
