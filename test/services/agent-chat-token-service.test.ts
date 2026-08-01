import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gatewayTokenService } from '../../src/services/token-service.js';

describe('Agent-chat gateway token service', () => {
  it('signs and verifies Agent-chat scope without Workflow or target identity', async () => {
    const token = await gatewayTokenService.signRunScopeToken({
      runId: 'run-agent-chat',
      workspaceId: 'ws-agent-chat',
      scopeType: 'agent_chat',
      agentId: 'agent-incident-analyst',
      sessionId: 'agent-conversation-1',
      principal: { type: 'user', id: 'user-1' },
      allowedProviders: ['openai'],
      allowedTools: ['incident.search'],
      allowedToolRefs: [{ serverId: 'incidents', toolName: 'search' }],
      allowedToolOperations: { 'incident.search': 'read' },
      contextGrants: ['workspace_metadata'],
      allowedModels: ['gpt-4.1-mini']
    });
    const claims = await gatewayTokenService.verifyRunScopeToken(token);

    assert.equal(claims.scopeType, 'agent_chat');
    assert.equal(claims.agentId, 'agent-incident-analyst');
    assert.equal(claims.workflowId, undefined);
    assert.equal(claims.targetId, undefined);
    assert.deepEqual(claims.contextGrants, ['workspace_metadata']);
  });

  it('requires an Agent identity at the signing boundary', async () => {
    await assert.rejects(
      gatewayTokenService.signRunScopeToken({
        runId: 'run-agent-chat-invalid',
        workspaceId: 'ws-agent-chat',
        scopeType: 'agent_chat',
        sessionId: 'agent-conversation-1',
        principal: { type: 'user', id: 'user-1' },
        allowedProviders: ['openai'],
        allowedTools: [],
        allowedModels: ['gpt-4.1-mini']
      } as never),
      /Agent identity/
    );
  });
});
