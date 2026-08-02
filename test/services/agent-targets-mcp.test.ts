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
import {
  normalizeAgentTargetAccessPolicy,
  targetAllowedByAgentPolicy
} from '../../src/services/agent-target-access.js';
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

  it('lists the full workspace target inventory when the Agent allows all targets', async () => {
    mock.method(repo, 'listTargets', async (workspaceId, options) => {
      assert.equal(workspaceId, 'workspace-1');
      assert.equal(options.targetType, 'kubernetes');
      assert.equal(options.limit, 10);
      assert.equal(options.targetAccess, undefined);
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

  it('passes allowlist and denylist policies into the target query', async () => {
    const observed: unknown[] = [];
    mock.method(repo, 'listTargets', async (_workspaceId, options) => {
      observed.push(options.targetAccess);
      return { items: [], nextCursor: undefined };
    });
    await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1',
      toolName: 'list_targets',
      arguments: {},
      targetAccessPolicy: { mode: 'allowlist', targetIds: ['cluster-1'] }
    });
    await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1',
      toolName: 'list_targets',
      arguments: {},
      targetAccessPolicy: { mode: 'denylist', targetIds: ['cluster-2'] }
    });
    assert.deepEqual(observed, [
      { mode: 'allowlist', targetIds: ['cluster-1'] },
      { mode: 'denylist', targetIds: ['cluster-2'] }
    ]);
  });

  it('normalizes target access defensively before enforcement', () => {
    assert.deepEqual(normalizeAgentTargetAccessPolicy({
      mode: 'allowlist',
      targetIds: [' target-b ', 'target-a', 'target-a']
    }), { mode: 'allowlist', targetIds: ['target-a', 'target-b'] });
    assert.deepEqual(normalizeAgentTargetAccessPolicy({
      mode: 'all',
      targetIds: ['ignored']
    }), { mode: 'all', targetIds: [] });
    assert.equal(targetAllowedByAgentPolicy({ mode: 'allowlist', targetIds: [] }, 'target-1'), false);
    assert.equal(targetAllowedByAgentPolicy({ mode: 'denylist', targetIds: [] }, 'target-1'), true);
  });

  it('does not query denied target IDs', async () => {
    const getTarget = mock.method(repo, 'getTarget', async () => {
      throw new Error('denied target lookup reached the repository');
    });
    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1',
        toolName: 'get_target',
        arguments: { target_id: 'cluster-2' },
        targetAccessPolicy: { mode: 'allowlist', targetIds: ['cluster-1'] }
      }),
      (error: unknown) => error instanceof AgentTargetsMcpExecutionError
        && error.code === 'TARGET_NOT_FOUND'
        && error.message === 'Target not found or unavailable to this Agent.'
    );
    assert.equal(getTarget.mock.callCount(), 0);
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
