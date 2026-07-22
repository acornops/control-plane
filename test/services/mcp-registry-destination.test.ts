import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGatewayMcpDestinationQuery } from '../../src/services/mcp-registry-client.js';

describe('gateway MCP destination descriptors', () => {
  it('builds the exact Agent destination scope', () => {
    assert.deepEqual(
      Object.fromEntries(buildGatewayMcpDestinationQuery('workspace-1', { kind: 'agent', id: 'agent-1' })),
      {
        workspace_id: 'workspace-1',
        scope_type: 'agent',
        agent_id: 'agent-1',
        target_id: 'agent-1',
        target_type: 'agent'
      }
    );
  });

  it('builds the exact target destination scope', () => {
    assert.deepEqual(
      Object.fromEntries(buildGatewayMcpDestinationQuery('workspace-1', {
        kind: 'target', id: 'target-1', targetType: 'virtual_machine'
      })),
      {
        workspace_id: 'workspace-1',
        target_id: 'target-1',
        target_type: 'virtual_machine'
      }
    );
  });
});
