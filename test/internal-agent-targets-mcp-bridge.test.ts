import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../src/agent/ws-server.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { config } from '../src/config.js';
import { callMcpTool } from '../src/controllers/internal-mcp-bridge-controller.js';
import {
  AGENT_TARGETS_MCP_SERVER_NAME,
  agentTargetsMcpTools
} from '../src/services/agent-targets-mcp-catalog.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { repo } from '../src/store/repository.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  updateWorkflowRun
} from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(() => {
  mock.restoreAll();
});
after(closeAutomationDatabaseFixtures);

const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

function responseWithClaims(claims: Record<string, unknown>) {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: { gatewayRunClaims: claims },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe('internal Agent Targets MCP bridge', () => {
  it('executes scoped target-awareness without requiring a bound target', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    const persistedSpecialist = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(workflow);
    assert.ok(persistedSpecialist);
    const serverId = randomUUID();
    const catalog = agentTargetsMcpTools(10_000);
    const installation = {
      id: serverId,
      name: AGENT_TARGETS_MCP_SERVER_NAME,
      url: config.BUILTIN_TARGET_MCP_SERVER_URL,
      enabled: true,
      credentialMode: 'none' as const,
      revision: 1,
      tools: catalog.map((tool) => ({
        serverId,
        toolName: tool.name,
        alias: `targets_${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        capability: tool.capability,
        enabled: tool.enabled,
        reviewState: tool.reviewState,
        riskLevel: tool.riskLevel,
        autoAllowed: tool.autoAllowed
      }))
    };
    const specialist = {
      ...persistedSpecialist,
      semanticCapabilityIds: [],
      targetAccessPolicy: { mode: 'allowlist' as const, targetIds: [] },
      mcpServers: [serverId],
      mcpTools: installation.tools.map((tool) => ({
        serverId,
        toolName: tool.toolName
      })),
      mcpInstallations: [installation]
    };
    const directWorkflow = workflow;
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow: directWorkflow,
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: [],
      actor,
    });
    const scopeWithForgedAlias = {
      ...compiledAccessScope,
      tools: [...compiledAccessScope.tools, 'forged_list_targets'],
      toolOperations: {
        ...compiledAccessScope.toolOperations,
        forged_list_targets: 'read' as const
      }
    };
    const session = await createWorkflowSession({
      workflow: directWorkflow,
      createdBy: actor.userId,
      compiledAccessScope: scopeWithForgedAlias
    });
    const created = await createWorkflowExecution({
      workflow: directWorkflow,
      session,
      compiledAccessScope: scopeWithForgedAlias,
      content: 'Check which production targets are healthy.',
      specialistSnapshot: specialist
    });
    const run = await updateWorkflowRun(created.run.id, { status: 'running' });
    assert.ok(run);
    const targetAgentCall = mock.method(agentGateway, 'callAgentMcpTool', async () => {
      throw new Error('Agent target-awareness must execute in the control plane');
    });
    mock.method(repo, 'insertWorkspaceAuditEvent', async () => null);
    const response = responseWithClaims({
      runId: run.id,
      workspaceId: run.workspaceId,
      sessionId: run.workflowSessionId,
      scopeType: 'workspace',
      executionId: run.executionId,
      executorRole: 'specialist',
      agentId: specialist.id,
      agentVersion: specialist.version,
      allowedTools: ['targets_list_targets'],
      allowedToolRefs: [{ serverId, toolName: 'list_targets' }],
      allowedToolOperations: { targets_list_targets: 'read' },
    });
    await callMcpTool({
      body: {
        name: 'list_targets',
        toolRef: { server_id: serverId, tool_name: 'list_targets' },
        arguments: { target_type: 'kubernetes' },
        toolCallId: 'call-targets-1'
      }
    } as never, response as never, (error?: unknown) => {
      if (error) throw error;
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      (response.body as { structuredContent: { items: Array<{ id: string }> } })
        .structuredContent.items.map((target) => target.id),
      []
    );
    assert.equal(targetAgentCall.mock.callCount(), 0);

    const forgedAliasResponse = responseWithClaims({
      runId: run.id,
      workspaceId: run.workspaceId,
      sessionId: run.workflowSessionId,
      scopeType: 'workspace',
      executionId: run.executionId,
      executorRole: 'specialist',
      agentId: specialist.id,
      agentVersion: specialist.version,
      allowedTools: ['forged_list_targets'],
      allowedToolRefs: [{ serverId, toolName: 'list_targets' }],
      allowedToolOperations: { forged_list_targets: 'read' },
    });
    await callMcpTool({
      body: {
        name: 'list_targets',
        toolRef: { server_id: serverId, tool_name: 'list_targets' },
        arguments: {}
      }
    } as never, forgedAliasResponse as never, (error?: unknown) => {
      if (error) throw error;
    });

    assert.equal(forgedAliasResponse.statusCode, 403);
    assert.equal(
      (forgedAliasResponse.body as { error: { code: string } }).error.code,
      'FORBIDDEN'
    );
    assert.equal(targetAgentCall.mock.callCount(), 0);
  });
});
