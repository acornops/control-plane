import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  callMcpTool,
  operationForToolCall,
  normalizeTargetAgentToolResult,
  publicAgentToolError,
  stableAgentRequestId
} from '../src/controllers/internal-mcp-bridge-controller.js';
import { callPlatformNativeTool } from '../src/controllers/internal-platform-native-tool-controller.js';
import { downloadWorkflowReport } from '../src/controllers/workflow-reports-controller.js';
import { AgentToolCallError, AgentUnavailableError } from '../src/agent/types.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { compileAgentRunScope } from '../src/services/agent-access.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { repo } from '../src/store/repository.js';
import {
  createAgentRunActivity,
  getAgentDefinition,
  listAgentDefinitions,
  updateAgentActivityRecord
} from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import { getWorkflowReport, renderWorkflowReportPdf } from '../src/store/repository-workflow-reports.js';
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

async function callNativeTool(runId: string, toolId: string, body: Record<string, unknown>) {
  const res = createResponseWithClaims({});
  await callPlatformNativeTool({ params: { runId, toolId }, body } as never, res as never, (err?: unknown) => {
    if (err) throw err;
  });
  return res;
}

async function callReportDownloadAs(reportId: string, userId: string) {
  const res = createResponseWithClaims({});
  await downloadWorkflowReport({
    params: { reportId },
    auth: { userId, credential: { type: 'session', sessionId: `session-${userId}` } }
  } as never, res as never, (err?: unknown) => {
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
    const entryAgent = agents.find((candidate) => candidate.id === workflow.entryAgentId);
    assert.ok(entryAgent);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      entryAgent,
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      exactTargets: [{ id: 'cluster-primary', targetType: 'kubernetes' }],
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Triage cluster',
      inputs: { targetId: 'cluster-primary' },
      targetId: 'cluster-primary',
      targetType: 'kubernetes',
      agentSnapshot: entryAgent as unknown as Record<string, unknown>
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

  it('dispatches workspace-native PDF tools before the target-adapter boundary', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'incident-report-pdf');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const entryAgent = agents.find((candidate) => candidate.id === workflow.entryAgentId);
    assert.ok(entryAgent);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      entryAgent,
      selectedAgents: [entryAgent],
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['selected_chat_sessions']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Generate incident report',
      inputs: { chatSessionIds: ['chat-session-1'] },
      agentSnapshot: entryAgent as unknown as Record<string, unknown>
    });
    const run = await updateWorkflowRun(created.run.id, { status: 'running' });
    assert.ok(run);
    const claims = {
        runId: run.id,
        workspaceId: run.workspaceId,
        sessionId: run.workflowSessionId,
        scopeType: 'workspace',
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        allowedTools: ['reports.pdf.generate'],
        allowedToolOperations: { 'reports.pdf.generate': 'read' },
        contextGrants: []
      };
    const body = {
      name: 'reports.pdf.generate',
      arguments: {
        title: 'Payments incident',
        markdown: '# Payments incident\n\nRecovered.',
        provenance: { workflowId: 'spoofed-workflow', sourceChatIds: ['chat-session-1'] }
      },
      toolCallId: 'call-report-1'
    };
    const response = await callMcpBridge(claims, body);

    assert.equal(response.statusCode, 200);
    const result = response.body as {
      structuredContent: { reportId: string; downloadUrl: string };
      isError: boolean;
    };
    assert.equal(result.isError, false);
    assert.match(result.structuredContent.reportId, /^[0-9a-f-]{36}$/);
    assert.equal(result.structuredContent.downloadUrl, `/api/v1/report-artifacts/${result.structuredContent.reportId}/download`);

    const repeated = await callMcpBridge(claims, body);
    assert.equal(repeated.statusCode, 200);
    assert.equal(
      (repeated.body as { structuredContent: { reportId: string } }).structuredContent.reportId,
      result.structuredContent.reportId
    );
    const persisted = await db.query<{ provenance: Record<string, unknown> }>(
      'SELECT provenance FROM workflow_reports WHERE run_id=$1 AND tool_call_id=$2',
      [run.id, 'call-report-1']
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0].provenance.workflowId, run.workflowId);
    assert.deepEqual(persisted.rows[0].provenance.sourceChatIds, ['chat-session-1']);

    const oversized = await callMcpBridge(claims, {
      name: 'reports.pdf.generate',
      arguments: { title: 'Too large', markdown: 'x'.repeat(262_145) },
      toolCallId: 'call-report-too-large'
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal((oversized.body as { error: { code: string } }).error.code, 'REPORT_SOURCE_TOO_LARGE');
  });

  it('creates idempotent PDF artifacts for target-chat tool calls', async () => {
    await db.query(
      `INSERT INTO workspace_memberships (workspace_id,user_id,role)
       VALUES ('workspace-1','user-1','operator')`
    );
    const session = await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Target report test');
    const message = await repo.addMessage(session.id, 'user', 'Summarize this investigation');
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

    const toolBody = {
      toolCallId: 'call-target-report-1',
      arguments: { title: 'Target investigation', markdown: '# Findings\n\nThe target is healthy.' }
    };
    const first = await callNativeTool(runId, 'reports.pdf.generate', toolBody);
    assert.equal(first.statusCode, 200);
    const firstReportId = (first.body as { structuredContent: { reportId: string } }).structuredContent.reportId;
    const repeated = await callNativeTool(runId, 'reports.pdf.generate', toolBody);
    assert.equal(
      (repeated.body as { structuredContent: { reportId: string } }).structuredContent.reportId,
      firstReportId
    );

    const persisted = await db.query<{ source: { markdown: string }; provenance: Record<string, unknown> }>(
      `SELECT source,provenance FROM workflow_reports
       WHERE target_run_id=$1 AND tool_call_id='call-target-report-1'`,
      [runId]
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0].source.markdown, '# Findings\n\nThe target is healthy.');
    assert.equal(persisted.rows[0].provenance.runId, runId);
    const storedReport = await getWorkflowReport(firstReportId);
    assert.ok(storedReport);
    const expectedExpiry = Date.now() + config.TARGET_CHAT_REPORT_RETENTION_DAYS * 86_400_000;
    assert.ok(Math.abs(Date.parse(storedReport.retentionExpiresAt) - expectedExpiry) < 60_000);
    const pdf = renderWorkflowReportPdf(storedReport);
    assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');
    assert.equal(pdf.subarray(-5).toString('ascii'), '%%EOF');
    const multipagePdf = renderWorkflowReportPdf({
      ...storedReport,
      source: { markdown: Array.from({ length: 120 }, (_, index) => `Evidence line ${index + 1}`).join('\n') }
    });
    assert.match(multipagePdf.toString('ascii'), /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 3/);

    const crossWorkspaceDownload = await callReportDownloadAs(firstReportId, 'user-outside-workspace');
    assert.equal(crossWorkspaceDownload.statusCode, 403);

    await repo.updateRun(runId, { status: 'completed' });
    const inactive = await callNativeTool(runId, 'reports.pdf.generate', {
      toolCallId: 'call-after-completion',
      arguments: { title: 'Too late', markdown: '# Too late' }
    });
    assert.equal(inactive.statusCode, 409);
    assert.equal((inactive.body as { error: { code: string } }).error.code, 'RUN_NOT_ACTIVE');
  });

  it('denies workspace-native functions for direct Agent runs', async () => {
    const agent = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(agent);
    const actor = {
      userId: 'user-1',
      role: 'admin' as const,
      permissions: getWorkspacePermissions('admin')
    };
    const run = await createAgentRunActivity({
      agent,
      triggeredBy: { type: 'user', userId: 'user-1' },
      prompt: 'Generate a report directly.',
      inputContext: {},
      compiledScope: compileAgentRunScope({
        agent,
        actor,
        approvedContextGrants: ['selected_chat_sessions'],
        mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true })
      }),
      clientRequestId: 'direct-agent-report-denial'
    });
    await updateAgentActivityRecord(run.id, { status: 'running' });

    const denied = await callNativeTool(run.id, 'reports.pdf.generate', {
      toolCallId: 'call-direct-agent-report',
      arguments: { title: 'Denied', markdown: '# Denied' }
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (denied.body as { error: { code: string } }).error.code,
      'WORKSPACE_NATIVE_TOOL_SCOPE_DENIED'
    );
  });
});
