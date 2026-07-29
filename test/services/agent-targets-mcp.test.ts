import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { toAgentMcpServer } from '../../src/services/agent-mcp-capabilities.js';
import {
  AGENT_TARGETS_MCP_TOOL_NAMES,
  AGENT_TARGETS_MCP_SERVER_NAME,
  agentMcpInstallationMatchesRunTarget,
  agentTargetsMcpTools
} from '../../src/services/agent-targets-mcp-catalog.js';
import {
  AgentTargetsMcpExecutionError,
  executeAgentTargetsMcpTool
} from '../../src/services/agent-targets-mcp-executor.js';
import { repo } from '../../src/store/repository.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import { encodeCursor, makeQuerySignature } from '../../src/utils/pagination.js';
import { normalizeTargetScope } from '../../src/controllers/agent-controller-helpers.js';
import { targetAllowedByAgentScope } from '../../src/services/target-scope-authorization.js';

afterEach(() => {
  mock.restoreAll();
});

function agent(targetIds: string[] = ['cluster-1']): AgentDefinition {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    targetScope: {
      type: 'selected_target',
      targetTypes: ['kubernetes'],
      targetIds
    }
  } as AgentDefinition;
}

describe('Agent Targets MCP server', () => {
  it('canonicalizes equivalent Agent target scopes before registry synchronization', () => {
    assert.deepEqual(normalizeTargetScope({
      type: 'selected_target',
      targetTypes: ['virtual_machine', 'kubernetes', 'virtual_machine'],
      targetIds: [' target-b ', 'target-a', 'target-a']
    }), {
      type: 'selected_target',
      targetTypes: ['kubernetes', 'virtual_machine'],
      targetIds: ['target-a', 'target-b']
    });
  });

  it('publishes exactly three approved read-only tools with bounded list inputs', () => {
    const tools = agentTargetsMcpTools(12_000);

    assert.deepEqual(tools.map((tool) => tool.name), [...AGENT_TARGETS_MCP_TOOL_NAMES]);
    assert.ok(tools.every((tool) => (
      tool.source === 'builtin'
      && tool.capability === 'read'
      && tool.reviewState === 'approved'
      && tool.riskLevel === 'read_only'
      && tool.autoAllowed === false
      && tool.timeoutMs === 12_000
    )));
    assert.deepEqual(
      (tools[0].inputSchema.properties as Record<string, unknown>).limit,
      { type: 'integer', minimum: 1, maximum: 25 }
    );
  });

  it('projects built-in Agent MCP servers as system-managed and toggleable', () => {
    const mapped = toAgentMcpServer({
      id: 'server-1',
      workspace_id: 'workspace-1',
      scope_type: 'agent',
      agent_id: 'agent-1',
      target_id: 'agent-1',
      target_type: 'agent',
      server_name: 'acornops-targets',
      server_url: 'http://control-plane:8081/internal/v1/mcp',
      enabled: true,
      auth_type: 'none',
      credential_mode: 'none',
      provenance_type: 'builtin',
      revision: 1,
      tools: []
    });

    assert.equal(mapped.isSystem, true);
    assert.equal(mapped.canDelete, false);
    assert.equal(mapped.canEditConnection, false);
    assert.equal(mapped.canToggle, true);
  });

  it('keeps target-awareness available to an unbound Agent while preserving remote MCP constraints', () => {
    const targetConstraints = { targetTypes: ['kubernetes'] as const, targetIds: ['cluster-1'] };
    const targetsInstallation = {
      name: AGENT_TARGETS_MCP_SERVER_NAME,
      url: 'http://control-plane:8081/internal/v1/mcp',
      targetConstraints
    };
    const remoteInstallation = {
      name: 'gitlab',
      url: 'https://gitlab.example/mcp',
      targetConstraints
    };

    assert.equal(agentMcpInstallationMatchesRunTarget(
      targetsInstallation,
      undefined,
      'http://control-plane:8081/internal/v1/mcp'
    ), true);
    assert.equal(agentMcpInstallationMatchesRunTarget(
      remoteInstallation,
      undefined,
      'http://control-plane:8081/internal/v1/mcp'
    ), false);
    assert.equal(agentMcpInstallationMatchesRunTarget(
      remoteInstallation,
      { id: 'cluster-1', targetType: 'kubernetes' },
      'http://control-plane:8081/internal/v1/mcp'
    ), true);
  });

  it('pushes Agent target constraints into list_targets before pagination', async () => {
    mock.method(repo, 'listTargets', async (_workspaceId, options) => {
      assert.deepEqual(options.allowedTargetTypes, ['kubernetes']);
      assert.deepEqual(options.allowedTargetIds, ['cluster-1']);
      assert.equal(options.targetType, 'kubernetes');
      assert.equal(options.limit, 10);
      return {
        items: [{
          id: 'cluster-1',
          workspaceId: 'workspace-1',
          targetType: 'kubernetes',
          name: 'Production',
          status: 'online',
          metadata: {},
          createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z'
        }],
        nextCursor: undefined
      };
    });

    const result = await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1',
      agent: agent(),
      toolName: 'list_targets',
      arguments: { target_type: 'kubernetes', limit: 10 }
    });

    assert.deepEqual(
      (result.structuredContent as { items: Array<{ id: string }> }).items.map((item) => item.id),
      ['cluster-1']
    );
  });

  it('hides targets outside the pinned Agent scope', async () => {
    mock.method(repo, 'getTarget', async () => ({
      id: 'cluster-2',
      workspaceId: 'workspace-1',
      targetType: 'kubernetes',
      name: 'Unscoped',
      status: 'online',
      metadata: {},
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    }));

    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1',
        agent: agent(),
        toolName: 'get_target',
        arguments: { target_id: 'cluster-2' }
      }),
      (error: unknown) => (
        error instanceof AgentTargetsMcpExecutionError
        && error.code === 'TARGET_NOT_FOUND'
        && error.status === 404
      )
    );
  });

  it('fails closed when a selected-target scope has no selections', async () => {
    const emptySelectedScope = {
      type: 'selected_target' as const,
      targetTypes: [],
      targetIds: []
    };
    assert.equal(targetAllowedByAgentScope(emptySelectedScope, {
      id: 'cluster-1',
      targetType: 'kubernetes'
    }), false);
    const listTargets = mock.method(repo, 'listTargets', async () => {
      throw new Error('An empty selected-target scope must not query the workspace target inventory.');
    });

    const result = await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1',
      agent: {
        ...agent(),
        targetScope: emptySelectedScope
      },
      toolName: 'list_targets',
      arguments: {}
    });

    assert.deepEqual(result.structuredContent, { items: [] });
    assert.equal(listTargets.mock.callCount(), 0);
  });

  it('rejects non-string and structurally invalid cursors before querying', async () => {
    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1',
        agent: agent(),
        toolName: 'list_targets',
        arguments: { cursor: 12 }
      }),
      (error: unknown) => (
        error instanceof AgentTargetsMcpExecutionError
        && error.code === 'TOOL_ARGS_INVALID'
      )
    );

    const signature = makeQuerySignature({
      q: '',
      targetType: undefined,
      allowedTargetTypes: ['kubernetes'],
      allowedTargetIds: ['cluster-1']
    });
    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1',
        agent: agent(),
        toolName: 'list_targets',
        arguments: {
          cursor: encodeCursor({
            signature,
            createdAt: 'not-a-timestamp',
            targetId: 'cluster-1'
          })
        }
      }),
      (error: unknown) => (
        error instanceof AgentTargetsMcpExecutionError
        && error.code === 'INVALID_CURSOR'
      )
    );
  });

  it('rejects unknown arguments instead of silently ignoring them', async () => {
    await assert.rejects(
      executeAgentTargetsMcpTool({
        workspaceId: 'workspace-1',
        agent: agent(),
        toolName: 'list_targets',
        arguments: { unexpected: true }
      }),
      (error: unknown) => (
        error instanceof AgentTargetsMcpExecutionError
        && error.code === 'TOOL_ARGS_INVALID'
        && error.status === 400
      )
    );
  });

  it('globally bounds target metadata before returning it to a model', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 50 }, (_, outer) => [
      `outer-${outer}`,
      Object.fromEntries(Array.from({ length: 50 }, (_, inner) => [
        `inner-${inner}`,
        'x'.repeat(1000)
      ]))
    ]));
    mock.method(repo, 'getTarget', async () => ({
      id: 'cluster-1',
      workspaceId: 'workspace-1',
      targetType: 'kubernetes',
      name: 'Production',
      status: 'online',
      metadata,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    }));
    mock.method(repo, 'getTargetAgentRegistration', async () => null);
    mock.method(repo, 'summarizeTargetIssues', async () => ({
      total: 0,
      active: 0,
      recovering: 0,
      critical: 0,
      warning: 0,
      info: 0
    }));

    const result = await executeAgentTargetsMcpTool({
      workspaceId: 'workspace-1',
      agent: agent(),
      toolName: 'get_target',
      arguments: { target_id: 'cluster-1' }
    });
    const bounded = (result.structuredContent as { metadata: Record<string, unknown> }).metadata;
    const countEntries = (value: unknown): number => {
      if (!value || typeof value !== 'object') return 0;
      if (Array.isArray(value)) {
        return value.length + value.reduce((total, item) => total + countEntries(item), 0);
      }
      return Object.keys(value).length + Object.values(value)
        .reduce((total, item) => total + countEntries(item), 0);
    };

    assert.ok(countEntries(bounded) <= 100);
    assert.ok(JSON.stringify(bounded).length < 50_000);
  });
});
