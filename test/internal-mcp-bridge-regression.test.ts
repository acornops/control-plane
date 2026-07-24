import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  callMcpTool,
  normalizeTargetAgentToolResult,
  operationForToolCall,
  publicAgentToolError,
  stableAgentRequestId
} from '../src/controllers/internal-mcp-bridge-controller.js';
import { callPlatformNativeTool } from '../src/controllers/internal-platform-native-tool-controller.js';
import { AgentToolCallError, AgentUnavailableError } from '../src/agent/types.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { db } from '../src/infra/db.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import { repo } from '../src/store/repository.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import { getWorkflowReport } from '../src/store/repository-workflow-reports.js';
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

async function callBridge(claims: Record<string, unknown>, body: Record<string, unknown>) {
  const response = responseWithClaims(claims);
  await callMcpTool({ body } as never, response as never, (error?: unknown) => {
    if (error) throw error;
  });
  return response;
}

async function callNative(runId: string, toolId: string, body: Record<string, unknown>) {
  const response = responseWithClaims({});
  await callPlatformNativeTool(
    { params: { runId, toolId }, body } as never,
    response as never,
    (error?: unknown) => {
      if (error) throw error;
    }
  );
  return response;
}

const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

describe('internal MCP and native-tool regressions', () => {
  it('classifies operations and derives stable run-scoped request IDs', () => {
    assert.equal(
      operationForToolCall({ allowedToolOperations: { read_tool: 'read' } }, 'read_tool'),
      'read'
    );
    assert.equal(operationForToolCall({ allowedToolOperations: {} }, 'unknown_tool'), 'write');
    const first = stableAgentRequestId('run-1', 'call-1');
    assert.equal(first, stableAgentRequestId('run-1', 'call-1'));
    assert.notEqual(first, stableAgentRequestId('run-2', 'call-1'));
    assert.match(first || '', /^tool_[a-f0-9]{64}$/);
    assert.equal(stableAgentRequestId('run-1', undefined), undefined);
  });

  it('sanitizes target-agent failures and requires the standard MCP envelope', () => {
    assert.deepEqual(publicAgentToolError(new AgentUnavailableError()), {
      code: 'TARGET_AGENT_UNAVAILABLE',
      message: 'Target agent is temporarily unavailable',
      outcome: 'not_started'
    });
    assert.deepEqual(
      publicAgentToolError(new AgentToolCallError('Tool timed out', -32003, {
        code: 'TOOL_TIMEOUT',
        outcome: 'unknown',
        operationId: 'operation-1',
        internal: 'drop-me'
      })),
      {
        code: 'TOOL_TIMEOUT',
        message: 'Tool timed out',
        outcome: 'unknown',
        operationId: 'operation-1'
      }
    );
    assert.deepEqual(publicAgentToolError(new AgentToolCallError('raw upstream body', -32603)), {
      code: 'AGENT_TOOL_ERROR',
      message: 'Agent tool call failed'
    });
    assert.throws(
      () => normalizeTargetAgentToolResult({ items: [] }, 'kubernetes'),
      /AgentK returned an invalid MCP tool result/
    );
    const envelope = {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { schemaVersion: 'acornops.full-tool-result.v1', data: {} },
      isError: false
    };
    assert.equal(normalizeTargetAgentToolResult(envelope, 'kubernetes'), envelope);
    assert.equal(normalizeTargetAgentToolResult(envelope, 'virtual_machine'), envelope);
  });

  it('routes an exact specialist Workflow target tool through AgentK with pinned run identity', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    const specialist = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(workflow);
    assert.ok(specialist);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
      targetRoute: { id: 'cluster-1', targetType: 'kubernetes' },
      actor,
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({ workflow, createdBy: actor.userId, compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      compiledAccessScope,
      content: 'Inspect the cluster.',
      promptDigest: digestPrompt('Inspect the cluster.'),
      bindingDigest: digestBindings([]),
      resourceBindings: [],
      resolvedAt: new Date().toISOString(),
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      specialistSnapshot: specialist
    });
    const run = await updateWorkflowRun(created.run.id, { status: 'running' });
    assert.ok(run);
    const audits: Array<Record<string, unknown>> = [];
    mock.method(repo, 'insertWorkspaceAuditEvent', async (event) => {
      audits.push(event.metadata || {});
      return null;
    });
    mock.method(agentGateway, 'callAgentMcpTool', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ items: [{ name: 'api-1' }] }) }],
      structuredContent: {
        schemaVersion: 'acornops.full-tool-result.v1',
        data: { items: [{ name: 'api-1' }] }
      },
      isError: false
    }));

    const response = await callBridge({
      runId: run.id,
      workspaceId: run.workspaceId,
      sessionId: run.workflowSessionId,
      scopeType: 'workspace',
      targetId: run.targetId,
      targetType: run.targetType,
      executionId: run.executionId,
      executorRole: 'specialist',
      agentId: specialist.id,
      agentVersion: specialist.version,
      allowedTools: ['list_resources'],
      allowedToolOperations: { list_resources: 'read' },
      contextGrants: []
    }, {
      name: 'list_resources',
      arguments: { kind: 'Pod' },
      toolCallId: 'call-1'
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { isError: boolean }).isError, false);
    assert.equal(audits[0].executionId, run.executionId);
    assert.equal(audits[0].executorRole, 'specialist');
  });

  it('creates one idempotent Workflow PDF artifact for repeated tool-call delivery', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'incident-report-pdf');
    const specialist = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(workflow);
    assert.ok(specialist);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
      actor,
      approvedContextGrants: []
    });
    const session = await createWorkflowSession({ workflow, createdBy: actor.userId, compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      compiledAccessScope,
      content: 'Generate an incident report.',
      promptDigest: digestPrompt('Generate an incident report.'),
      bindingDigest: digestBindings([]),
      resourceBindings: [],
      resolvedAt: new Date().toISOString(),
      specialistSnapshot: specialist
    });
    const run = await updateWorkflowRun(created.run.id, { status: 'running' });
    assert.ok(run);
    const claims = {
      runId: run.id,
      workspaceId: run.workspaceId,
      sessionId: run.workflowSessionId,
      scopeType: 'workspace',
      executionId: run.executionId,
      executorRole: 'specialist',
      agentId: specialist.id,
      agentVersion: specialist.version,
      allowedTools: ['reports.pdf.generate'],
      allowedToolOperations: { 'reports.pdf.generate': 'read' },
      contextGrants: []
    };
    const body = {
      name: 'reports.pdf.generate',
      arguments: { title: 'Incident', markdown: '# Incident\n\nRecovered.' },
      toolCallId: 'report-call-1'
    };
    const first = await callBridge(claims, body);
    const repeated = await callBridge(claims, body);
    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 200);
    const reportId = (first.body as { structuredContent: { reportId: string } }).structuredContent.reportId;
    assert.equal(
      (repeated.body as { structuredContent: { reportId: string } }).structuredContent.reportId,
      reportId
    );
    const persisted = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM workflow_reports WHERE run_id=$1 AND tool_call_id=$2',
      [run.id, 'report-call-1']
    );
    assert.equal(Number(persisted.rows[0].count), 1);
    assert.ok(await getWorkflowReport(reportId));
  });

  it('keeps target-chat native PDF artifacts idempotent and rejects inactive runs', async () => {
    const session = await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Target report');
    const message = await repo.addMessage(session.id, 'user', 'Summarize');
    const runId = randomUUID();
    await repo.addRun({
      id: runId,
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: session.id,
      messageId: message.id,
      llmProvider: 'openai',
      llmModel: 'gpt-5-nano',
      llmReasoningSummaryMode: 'off',
      llmReasoningEffort: 'low',
      toolAccessMode: 'read_only',
      status: 'running',
      requestedAt: new Date().toISOString()
    });
    const body = {
      toolCallId: 'target-report-1',
      arguments: { title: 'Target', markdown: '# Healthy' }
    };
    const first = await callNative(runId, 'reports.pdf.generate', body);
    const repeated = await callNative(runId, 'reports.pdf.generate', body);
    assert.equal(
      (first.body as { structuredContent: { reportId: string } }).structuredContent.reportId,
      (repeated.body as { structuredContent: { reportId: string } }).structuredContent.reportId
    );
    await repo.updateRun(runId, { status: 'completed' });
    const inactive = await callNative(runId, 'reports.pdf.generate', {
      toolCallId: 'too-late',
      arguments: { title: 'Late', markdown: '# Late' }
    });
    assert.equal(inactive.statusCode, 409);
    assert.equal((inactive.body as { error: { code: string } }).error.code, 'RUN_NOT_ACTIVE');
  });
});
