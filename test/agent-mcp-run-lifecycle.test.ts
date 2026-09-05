import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { bootstrapAgentChatRun } from '../src/controllers/internal-agent-chat-bootstrap.js';
import { LlmGatewayHttpError } from '../src/services/mcp-registry-client.js';
import { repo } from '../src/store/repository.js';
import type { AgentDefinition } from '../src/types/agents.js';
import type { Run } from '../src/types/domain.js';
import {
  createResponse,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function agentSnapshot(): AgentDefinition {
  return {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'Agent',
    avatarEmoji: '🤖',
    instructions: 'Inspect evidence.',
    status: 'active',
    reviewState: 'reviewed',
    providerType: 'internal',
    ownerUserId: 'user-1',
    createdBy: 'user-1',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    mcpServers: [],
    mcpTools: [],
    mcpInstallations: [],
    tools: [],
    nativeToolConfigs: {},
    skills: [],
    skillInstallations: [],
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'read_only',
    semanticCapabilityIds: [],
    readiness: { status: 'ready', reasons: [] }
  };
}

function agentRun(): Run {
  const agent = agentSnapshot();
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    conversationKind: 'agent_chat',
    agentId: agent.id,
    agentSnapshot: agent,
    compiledAccessScope: {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      actor: { userId: 'user-1', role: 'admin' },
      mode: 'read_only',
      semanticCapabilityIds: [],
      capabilityRestrictionMode: 'inherit',
      requiredPermissions: ['create_read_only_runs'],
      grantedCapabilities: ['create_read_only_runs'],
      mcpServers: [],
      mcpTools: [],
      tools: [],
      toolOperations: {},
      nativeToolConfigs: {},
      enabledSkills: [],
      approvalGates: [],
      permissionMode: 'read_only',
      principal: { type: 'user', id: 'user-1', membershipGeneration: 1 }
    },
    sessionId: 'session-1',
    messageId: 'message-1',
    principal: { type: 'user', id: 'user-1', membershipGeneration: 1 },
    llmProvider: 'openai',
    llmModel: 'gpt-5-nano',
    llmReasoningSummaryMode: 'off',
    llmReasoningEffort: 'low',
    toolAccessMode: 'read_only',
    status: 'running',
    requestedAt: '2026-08-10T00:00:00.000Z'
  };
}

describe('Agent run MCP lifecycle fence', () => {
  it('blocks bootstrap even when the pinned Agent has no MCP tool refs', async () => {
    repo.getSession = async () => ({
      id: 'session-1',
      workspaceId: 'workspace-1',
      conversationKind: 'agent_chat',
      agentId: 'agent-1',
      createdBy: 'user-1',
      origin: 'manual',
      title: 'Agent',
      status: 'open',
      preferredAccessMode: 'read_only',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      lastMessageAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z'
    });
    const gateway = mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?') && init?.method === 'GET') {
        return Response.json({ detail: {
          code: 'MCP_LIFECYCLE_FENCED',
          message: 'MCP lifecycle teardown is in progress for this destination.',
          retryable: false
        } }, { status: 409 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    await assert.rejects(
      bootstrapAgentChatRun(agentRun(), createResponse() as never),
      (error: unknown) => error instanceof LlmGatewayHttpError
        && error.status === 409
        && error.gatewayCode === 'MCP_LIFECYCLE_FENCED'
    );
    assert.equal(gateway.mock.callCount(), 1);
    assert.match(String(gateway.mock.calls[0].arguments[0]), /scope_type=agent/);
    assert.match(String(gateway.mock.calls[0].arguments[0]), /agent_id=agent-1/);
  });
});
