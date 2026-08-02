import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { config } from '../../src/config.js';
import { gatewayTokenService } from '../../src/services/token-service.js';

describe('Workflow gateway token service', () => {
  it('signs and verifies Workflow run scope without a synthetic target', async () => {
    const token = await gatewayTokenService.signRunScopeToken({
      runId: 'run-workflow',
      workspaceId: 'ws-workflow',
      scopeType: 'workspace',
      workflowId: 'workflow-1',
      executionId: 'workflow-execution-1',
      workflowSessionId: 'workflow-session-1',
      executorRole: 'specialist',
      agentId: 'agent-cluster-triage',
      triggerId: 'trigger-manual-1',
      sessionId: 'workflow-session-1',
      principal: { type: 'service_identity', id: 'service-workflow-1' },
      allowedProviders: ['openai'],
      allowedTools: ['mcp.tools.list', 'audit.events.search', 'inspect'],
      allowedToolRefs: [{ serverId: 'server-observability', toolName: 'inspect' }],
      allowedToolOperations: {
        'mcp.tools.list': 'read',
        'audit.events.search': 'read'
      },
      contextGrants: ['audit_events', 'workspace_metadata'],
      maxOutputTokens: 1024,
      allowedModels: ['gpt-4.1-mini']
    });
    const verification = await jwtVerify(
      token,
      createLocalJWKSet(await gatewayTokenService.getJwks() as JSONWebKeySet),
      { issuer: config.GATEWAY_TOKEN_ISSUER, audience: config.GATEWAY_TOKEN_AUDIENCE }
    );

    assert.equal(verification.payload.target_id, undefined);
    assert.equal(verification.payload.target_type, undefined);
    assert.deepEqual(verification.payload.scope, { type: 'workspace' });
    assert.equal(verification.payload.workflow_id, 'workflow-1');
    assert.equal(verification.payload.execution_id, 'workflow-execution-1');
    assert.equal(verification.payload.executor_role, 'specialist');
    assert.equal(verification.payload.workflow_session_id, 'workflow-session-1');
    assert.equal(verification.payload.agent_id, 'agent-cluster-triage');
    assert.equal(verification.payload.trigger_id, 'trigger-manual-1');
    assert.deepEqual(verification.payload.permissions, {
      allowed_providers: ['openai'],
      allowed_tools: ['mcp.tools.list', 'audit.events.search', 'inspect'],
      allowed_tool_refs: [{ server_id: 'server-observability', tool_name: 'inspect' }],
      allowed_native_tools: [],
      allowed_tool_operations: { 'mcp.tools.list': 'read', 'audit.events.search': 'read' },
      context_grants: ['audit_events', 'workspace_metadata'],
      max_output_tokens: 1024,
      allowed_models: ['gpt-4.1-mini'],
      resource_bindings: []
    });

    const claims = await gatewayTokenService.verifyRunScopeToken(token);
    assert.equal(claims.scopeType, 'workspace');
    assert.equal(claims.workflowId, 'workflow-1');
    assert.equal(claims.executionId, 'workflow-execution-1');
    assert.equal(claims.executorRole, 'specialist');
    assert.equal(claims.workflowSessionId, 'workflow-session-1');
    assert.equal(claims.agentId, 'agent-cluster-triage');
    assert.equal(claims.triggerId, 'trigger-manual-1');
    assert.equal(claims.targetId, undefined);
    assert.equal(claims.targetType, undefined);
    assert.deepEqual(claims.contextGrants, ['audit_events', 'workspace_metadata']);
    assert.deepEqual(claims.allowedToolRefs, [{ serverId: 'server-observability', toolName: 'inspect' }]);
  });
});
