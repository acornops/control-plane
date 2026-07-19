import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  callMcpTool,
  operationForToolCall,
  normalizeTargetAgentToolResult,
  publicAgentToolError,
  stableAgentRequestId
} from '../src/controllers/internal-mcp-bridge-controller.js';
import { AgentToolCallError, AgentUnavailableError } from '../src/agent/types.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { repo } from '../src/store/repository.js';
import { listAgentDefinitions } from '../src/store/repository-agents.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  updateWorkflowRun
} from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);
const originalGetTarget = repo.getTarget;
const originalInsertWorkspaceAuditEvent = repo.insertWorkspaceAuditEvent;
afterEach(() => {
  mock.restoreAll();
  repo.getTarget = originalGetTarget;
  repo.insertWorkspaceAuditEvent = originalInsertWorkspaceAuditEvent;
});

function createResponseWithClaims(claims: Record<string, unknown>) {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: {
      gatewayRunClaims: claims
    },
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

async function callMcpBridge(claims: Record<string, unknown>, body: Record<string, unknown>) {
  const res = createResponseWithClaims(claims);
  await callMcpTool({ body } as never, res as never, (err?: unknown) => {
    if (err) throw err;
  });
  return res;
}

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

  it('derives stable, run-scoped agent request IDs for idempotent retries', () => {
    const first = stableAgentRequestId('run-1', 'call-1');
    assert.equal(first, stableAgentRequestId('run-1', 'call-1'));
    assert.notEqual(first, stableAgentRequestId('run-2', 'call-1'));
    assert.match(first || '', /^tool_[a-f0-9]{64}$/);
    assert.equal(stableAgentRequestId('run-1', undefined), undefined);
  });

  it('exposes only sanitized AgentK timeout receipt fields', () => {
    assert.deepEqual(publicAgentToolError(new AgentUnavailableError()), {
      code: 'TARGET_AGENT_UNAVAILABLE',
      message: 'Target agent is temporarily unavailable',
      outcome: 'not_started'
    });
    assert.deepEqual(publicAgentToolError(new AgentToolCallError('Tool timed out', -32003, {
      code: 'TOOL_TIMEOUT', outcome: 'unknown', operationId: 'operation-1', internal: 'drop-me'
    })), {
      code: 'TOOL_TIMEOUT', message: 'Tool timed out', outcome: 'unknown', operationId: 'operation-1'
    });
    assert.deepEqual(publicAgentToolError(new AgentToolCallError('raw upstream body', -32603)), {
      code: 'AGENT_TOOL_ERROR', message: 'Agent tool call failed'
    });
  });

  it('requires the standard MCP envelope from both AgentK and AgentV', () => {
    const rawVmResult = { services: [{ name: 'nginx', status: 'running' }] };
    assert.throws(() => normalizeTargetAgentToolResult(rawVmResult, 'virtual_machine'), /AgentV returned an invalid MCP tool result/);
    assert.throws(
      () => normalizeTargetAgentToolResult({ items: [] }, 'kubernetes'),
      /AgentK returned an invalid MCP tool result/
    );
    const agentk = {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { schemaVersion: 'acornops.full-tool-result.v1', data: {} },
      isError: false,
    };
    assert.equal(normalizeTargetAgentToolResult(agentk, 'kubernetes'), agentk);
    assert.equal(normalizeTargetAgentToolResult(agentk, 'virtual_machine'), agentk);
  });

  it('routes target-scoped workflow tools through the built-in AgentK bridge', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents,
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const agent = agents.find((candidate) => candidate.id === 'agent-cluster-triage');
    assert.ok(agent);
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Triage cluster',
      inputs: { targetId: 'cluster-primary' },
      targetId: 'cluster-primary',
      targetType: 'kubernetes',
      agentSnapshot: agent as unknown as Record<string, unknown>
    });
    const run = await updateWorkflowRun(
      created.run.id,
      { status: 'running' }
    );
    assert.ok(run);

    let auditOperation = '';
    let auditMetadata: Record<string, unknown> = {};
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditOperation = event.operation;
      auditMetadata = event.metadata || {};
      return null;
    };
    repo.getTarget = async () => ({
      id: 'cluster-primary', workspaceId: 'workspace-1', targetType: 'kubernetes', name: 'Primary',
      status: 'online', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    mock.method(agentGateway, 'callAgentMcpTool', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ items: [{ kind: 'Pod', name: 'api-1' }] }) }],
      structuredContent: {
        schemaVersion: 'acornops.full-tool-result.v1',
        data: { items: [{ kind: 'Pod', name: 'api-1' }] }
      },
      isError: false
    }));

    const response = await callMcpBridge(
      {
        runId: run.id,
        workspaceId: run.workspaceId,
        sessionId: run.workflowSessionId,
        scopeType: 'target',
        targetId: 'cluster-primary',
        targetType: 'kubernetes',
        allowedTools: ['list_resources'],
        allowedToolOperations: { list_resources: 'read' },
        contextGrants: []
      },
      { name: 'list_resources', arguments: { kind: 'Pod' }, toolCallId: 'call-1' }
    );

    assert.equal(response.statusCode, 200);
    const content = (response.body as { content: Array<{ text: string }>; isError: boolean }).content;
    const payload = JSON.parse(content[0].text) as { items: Array<{ name: string }> };
    assert.equal((response.body as { isError: boolean }).isError, false);
    assert.equal(payload.items[0].name, 'api-1');
    assert.equal(auditOperation, 'read');
    assert.equal(auditMetadata.source, 'builtin_mcp_bridge');
    assert.equal(auditMetadata.workflowId, 'cluster-triage');
    assert.equal(auditMetadata.workflowRunId, run.workflowRunId);
  });

  it('generates an incident report artifact with the built-in workflow tool', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'incident-report-pdf');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents,
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['selected_chat_sessions']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const agent = agents.find((candidate) => candidate.id === 'agent-incident-reporter');
    assert.ok(agent);
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Generate incident report',
      inputs: { chatSessionIds: ['chat-1'] },
      agentSnapshot: agent as unknown as Record<string, unknown>
    });
    const run = await updateWorkflowRun(created.run.id, { status: 'running' });
    assert.ok(run);

    const response = await callMcpBridge(
      {
        runId: run.id,
        workspaceId: run.workspaceId,
        sessionId: run.workflowSessionId,
        scopeType: 'workspace',
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        workflowStepId: run.workflowStepId,
        allowedTools: ['reports.pdf.generate'],
        allowedToolOperations: { 'reports.pdf.generate': 'read' },
        contextGrants: run.compiledAccessScope.contextGrants
      },
      {
        name: 'reports.pdf.generate',
        arguments: { title: 'Payments incident', markdown: '# Payments incident\n\nRecovered.' }
      }
    );

    assert.equal(response.statusCode, 200);
    const content = (response.body as { content: Array<{ text: string }> }).content;
    const payload = JSON.parse(content[0].text) as {
      artifact: { id: string; type: string; mediaType: string; downloadPath: string };
    };
    assert.equal(payload.artifact.type, 'pdf');
    assert.equal(payload.artifact.mediaType, 'application/pdf');
    assert.equal(payload.artifact.downloadPath, `/api/v1/workflow-reports/${payload.artifact.id}/download`);
  });
});
