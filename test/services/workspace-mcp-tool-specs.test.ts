import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWorkspaceMcpToolSpecs } from '../../src/services/workspace-mcp-tool-specs.js';

describe('target-independent Targets MCP catalog', () => {
  it('projects granted tools without requiring workspace targets', async () => {
    const tools = await resolveWorkspaceMcpToolSpecs({
      workspaceId: 'workspace-with-no-targets',
      runId: 'run-1',
      mode: 'read_write',
      refs: [
        { serverId: 'targets', toolName: 'list_resources' },
        { serverId: 'targets', toolName: 'get_host_summary' },
        { serverId: 'targets', toolName: 'restart_service' }
      ]
    });

    assert.deepEqual(tools.map((tool) => tool.name), [
      'get_host_summary',
      'list_resources',
      'restart_service'
    ]);
    const kubernetes = tools.find((tool) => tool.name === 'list_resources');
    const virtualMachine = tools.find((tool) => tool.name === 'get_host_summary');
    assert.deepEqual(
      (kubernetes?.input_schema.properties as Record<string, { enum?: string[] }>).target_type.enum,
      ['kubernetes']
    );
    assert.deepEqual(
      (virtualMachine?.input_schema.properties as Record<string, { enum?: string[] }>).target_type.enum,
      ['virtual_machine']
    );
    for (const tool of tools) {
      assert.deepEqual(
        (tool.input_schema.required as string[]).slice(-2),
        ['target_id', 'target_type']
      );
    }
  });

  it('keeps write tools out of read-only runs', async () => {
    const tools = await resolveWorkspaceMcpToolSpecs({
      workspaceId: 'workspace-with-no-targets',
      runId: 'run-2',
      mode: 'read_only',
      refs: [
        { serverId: 'targets', toolName: 'query_logs' },
        { serverId: 'targets', toolName: 'restart_service' }
      ]
    });
    assert.deepEqual(tools.map((tool) => tool.name), ['query_logs']);
  });
});
