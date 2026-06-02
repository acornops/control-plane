import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { operationForToolCall } from '../src/controllers/internal-mcp-bridge-controller.js';

describe('internal MCP bridge audit classification', () => {
  it('uses token tool-operation metadata and defaults unknown tools to write', () => {
    assert.equal(
      operationForToolCall({ allowedToolOperations: { get_resource: 'read', restart_workload: 'write' } }, 'get_resource'),
      'read'
    );
    assert.equal(
      operationForToolCall({ allowedToolOperations: { get_resource: 'read', restart_workload: 'write' } }, 'restart_workload'),
      'write'
    );
    assert.equal(operationForToolCall({ allowedToolOperations: {} }, 'unknown_tool'), 'write');
  });
});
