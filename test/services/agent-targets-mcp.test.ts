import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { toAgentMcpServer } from '../../src/services/agent-mcp-capabilities.js';
import {
  AGENT_TARGETS_MCP_SERVER_NAME,
  AGENT_TARGETS_MCP_TOOL_NAMES,
  agentTargetsMcpTools,
  isAgentTargetsMcpInstallation
} from '../../src/services/agent-targets-mcp-catalog.js';
import {
  AgentTargetsMcpExecutionError,
  executeAgentTargetsMcpTool
} from '../../src/services/agent-targets-mcp-executor.js';
import { repo } from '../../src/store/repository.js';

afterEach(() => mock.restoreAll());

describe('Agent Targets MCP server', () => {
  it('publishes exactly three approved read-only tools', () => {
    const tools = agentTargetsMcpTools(12_000);
    assert.deepEqual(tools.map((tool) => tool.name), [...AGENT_TARGETS_MCP_TOOL_NAMES]);
    assert.ok(tools.every((tool) => tool.source === 'builtin'
      && tool.capability === 'read'
      && tool.reviewState === 'approved'
      && tool.riskLevel === 'read_only'
      && tool.timeoutMs === 12_000));
  });

  it('identifies only the exact built-in Targets installation', () => {
    assert.equal(isAgentTargetsMcpInstallation({
      name: AGENT_TARGETS_MCP_SERVER_NAME,
      url: 'http://control-plane:8081/internal/v1/mcp'
    }, 'http://control-plane:8081/internal/v1/mcp'), true);
    assert.equal(isAgentTargetsMcpInstallation({
      name: 'Custom Targets',
      url: 'http://control-plane:8081/internal/v1/mcp'
    }, 'http://control-plane:8081/internal/v1/mcp'), false);
  });

  it('projects built-in Agent MCP servers as managed, non-editable, and toggleable', () => {
    const mapped = toAgentMcpServer({
      id: 'server-1', workspace_id: 'workspace-1', scope_type: 'agent', agent_id: 'agent-1',
      target_id: 'agent-1', target_type: 'agent', server_name: AGENT_TARGETS_MCP_SERVER_NAME,
      server_url: 'http://control-plane:8081/internal/v1/mcp', enabled: true, auth_type: 'none',
      credential_mode: 'none', provenance_type: 'builtin', revision: 1, tools: []
    });
    assert.equal(mapped.isSystem, true);
    assert.equal(mapped.canDelete, false);
    assert.equal(mapped.canEditConnection, false);
    assert.equal(mapped.canToggle, true);
  });

  it('lists the full workspace target inventory without an Agent target binding', async () => {
    mock.method(repo, 'listTargets', async (workspaceId, options) => {
      assert.equal(workspaceId, 'workspace-1');
      assert.equal(options.targetType, 'kubernetes');
      assert.equal(options.limit, 10);
      assert.equal('allowedTargetIds' in options, false);
      return {
        items: [{
          id: 'cluster-1', workspaceId, targetType: 'kubernetes', name: 'Production',
          status: 'online', metadata: {}, createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z'
        }],
        nextCursor: undefined
      };
    });
    const result = await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1', toolName: 'list_targets',
      arguments: { target_type: 'kubernetes', limit: 10 }
    });
    assert.deepEqual(
      (result.structuredContent as { items: Array<{ id: string }> }).items.map((item) => item.id),
      ['cluster-1']
    );
  });

  it('rejects unknown arguments before querying', async () => {
    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1', toolName: 'list_targets', arguments: { target_id: 'cluster-1' }
      }),
      (error: unknown) => error instanceof AgentTargetsMcpExecutionError
        && error.code === 'TOOL_ARGS_INVALID'
    );
  });
});
