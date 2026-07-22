import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { bootstrap, summarizeRunEventCounts } from '../src/controllers/internal-execution-controller.js';
import { normalizeToolCapability } from '../src/services/target-run-tool-resolution.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { gatewayTokenService } from '../src/services/token-service.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { repo } from '../src/store/repository.js';
import { createWorkflowExecution, createWorkflowSession, getWorkflowDefinition } from '../src/store/repository-workflows.js';
import { runtime } from '../src/store/runtime.js';
import { listAgentDefinitions } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  callController,
  createRequest,
  createRun,
  createSessionRecord,
  createTarget,
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';
import { createRunEvent, mockVmBootstrapToolFetch } from './helpers/internal-execution-bootstrap-fixtures.js';

const originalAppendRunEvents = repo.appendRunEvents;
const originalUpdateRun = repo.updateRun;
const originalUpsertAssistantFinalMessage = repo.upsertAssistantFinalMessage;
const originalWebhookEmit = webhooks.emit;

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  webhooks.emit = (_event: WebhookEventInput) => undefined;
  repo.insertWorkspaceAuditEvent = async (event) => ({
    id: 'audit-event-1',
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    actor: {
      type: event.actorType || (event.actorUserId ? 'user' : 'system'),
      ...(event.actorUserId ? { userId: event.actorUserId } : {})
    },
    object: {
      type: event.objectType,
      ...(event.objectId ? { id: event.objectId } : {}),
      ...(event.objectName ? { name: event.objectName } : {})
    },
    summary: event.summary,
    metadata: event.metadata ?? {},
    occurredAt: '2026-05-24T00:00:00.000Z'
  });
  repo.insertTargetChatActivityEvent = async (event) => ({
    id: 'activity-event-1',
    workspaceId: event.workspaceId,
    targetId: event.targetId,
    targetType: event.targetType,
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    type: event.type,
    payload: event.payload ?? {},
    createdAt: '2026-05-24T00:00:00.000Z'
  });
  repo.listEnabledValidTargetSkills = async () => [];
  repo.getRunSkillCatalog = async () => [];
  repo.getTargetToolSetting = async () => null;
  repo.listEnabledTargetToolSettings = async () => [];
});
afterEach(() => {
  restoreControllerRegressionState();
  repo.appendRunEvents = originalAppendRunEvents;
  repo.updateRun = originalUpdateRun;
  repo.upsertAssistantFinalMessage = originalUpsertAssistantFinalMessage;
  webhooks.emit = originalWebhookEmit;
  runtime.clearRunEvents('run-1');
});

after(closeAutomationDatabaseFixtures);

describe('internal execution bootstrap audit metadata', () => {
  it('defaults unknown tool capabilities to write for audit classification', () => {
    assert.equal(normalizeToolCapability({ capability: 'read' }), 'read');
    assert.equal(normalizeToolCapability({ capability: 'write' }), 'write');
    assert.equal(normalizeToolCapability({ capability: undefined }), 'write');
    assert.equal(normalizeToolCapability({ capability: 'unknown' as never }), 'write');
  });

  it('aggregates unknown run event types before metrics/logging', () => {
    const counts = summarizeRunEventCounts([
      createRunEvent('run_progress', 1),
      createRunEvent('future_custom_event', 2),
      createRunEvent('another_custom_event', 3)
    ]);

    assert.deepEqual(Object.fromEntries(counts), {
      run_progress: 1,
      other: 2
    });
  });

  it('allows VM write tools when the target advertises write capability and the run is read-write', async () => {
    repo.getRun = async () => createRun({ targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: 'read_write' });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read', 'write']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mockVmBootstrapToolFetch();

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const tools = (response.body as {
      tools: {
        allowed_tools: string[];
        native_tools: Array<{ id: string }>;
        platform_functions: Array<{ id: string; model_alias: string }>;
        tool_specs: Array<{ name: string }>;
        gateway: { token: string };
      };
    }).tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'restart_service', 'acornops_generate_pdf_report']);
    assert.deepEqual(tools.native_tools, [{
      id: 'web_search',
      config: { domainFilters: { allowedDomains: [], blockedDomains: [] } }
    }]);
    assert.deepEqual(tools.platform_functions, [
      { id: 'reports.pdf.generate', model_alias: 'acornops_generate_pdf_report' }
    ]);
    assert.ok(tools.tool_specs.some((tool) => tool.name === 'acornops_generate_pdf_report'));
    const claims = await gatewayTokenService.verifyRunScopeToken(tools.gateway.token);
    assert.deepEqual(claims.allowedNativeTools, [{
      id: 'web_search',
      config: { domainFilters: { allowedDomains: [], blockedDomains: [] } }
    }]);
  });

  it('reports read-only run mode when configured write tools are filtered from bootstrap', async () => {
    repo.getRun = async () => createRun({ targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: 'read_only' });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read', 'write']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mockVmBootstrapToolFetch();

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const tools = (response.body as { tools: { allowed_tools: string[]; write_unavailable_reason: string | null } }).tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'acornops_generate_pdf_report']);
    assert.equal(tools.write_unavailable_reason, 'run_read_only');
  });

  it('reports read-only agent mode when configured write tools are filtered from bootstrap', async () => {
    repo.getRun = async () => createRun({ targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: 'read_write' });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mockVmBootstrapToolFetch();

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const tools = (response.body as { tools: { allowed_tools: string[]; write_unavailable_reason: string | null } }).tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'acornops_generate_pdf_report']);
    assert.equal(tools.write_unavailable_reason, 'agent_write_disabled');
  });

  it('bootstraps with the run provider/model snapshot even when workspace defaults changed later', async () => {
    repo.getRun = async () => createRun({
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      clusterId: undefined,
      llmProvider: 'openai',
      llmModel: 'gpt-5.5'
    });
    repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine', name: 'vm' });
    repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.getTargetAgentRegistration = async () => null;
    repo.getWorkspaceAiSettings = async () => ({
      workspaceId: 'workspace-1',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.5'
    });
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const llm = (response.body as { llm: { provider: string; model: string } }).llm;

    assert.equal(response.statusCode, 200);
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.model, 'gpt-5.5');
  });

  it('does not expose agent-advertised tools that are missing from the gateway registry', async () => {
    repo.getRun = async () => createRun({ targetId: 'cluster-1', targetType: 'kubernetes', toolAccessMode: 'read_only' });
    repo.getTarget = async () => createTarget({ id: 'cluster-1', targetType: 'kubernetes', name: 'cluster' });
    repo.getSession = async () => createSessionRecord({ targetId: 'cluster-1', targetType: 'kubernetes', clusterId: 'cluster-1' });
    repo.getTargetAgentRegistration = async () => ({
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      workspaceId: 'workspace-1',
      agentKeyHash: 'hash',
      keyVersion: 1,
      capabilities: ['read']
    });
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'list_pods',
        description: 'List pods',
        capability: 'read' as const,
        timeout_ms: 10000,
        version: 'v1',
        input_schema: { type: 'object' }
      }
    ]);
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/api/v1/internal/mcp/servers') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'server-1',
          workspace_id: 'workspace-1',
          target_id: 'cluster-1',
          target_type: 'kubernetes',
          server_name: 'acornops-target-agent',
          server_url: 'http://control-plane:8081/internal/v1/mcp',
          enabled: true,
          auth_type: 'none',
          tools: []
        }), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));
    const tools = (response.body as { tools: { allowed_tools: string[]; tool_specs: unknown[] } }).tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(tools.allowed_tools, ['acornops_generate_pdf_report']);
    assert.deepEqual((tools.tool_specs as Array<{ name: string }>).map((tool) => tool.name), [
      'acornops_generate_pdf_report'
    ]);
  });

  it('bootstraps cluster triage with target scope and only built-in tools', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const entryAgent = agents.find((candidate) => candidate.id === workflow.entryAgentId);
    assert.ok(entryAgent);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      entryAgent,
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      targetRoute: { id: 'cluster-primary', targetType: 'kubernetes' },
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({
      workflow,
      createdBy: 'user-1',
      compiledAccessScope
    });
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Triage the primary cluster.',
      promptDigest: digestPrompt('Triage the primary cluster.'),
      bindingDigest: digestBindings([]),
      resourceBindings: [],
      resolvedAt: new Date().toISOString(),
      inputs: { targetId: 'cluster-primary', severity: 'high' },
      targetId: 'cluster-primary',
      targetType: 'kubernetes',
      agentSnapshot: entryAgent as unknown as Record<string, unknown>,
      llmProvider: 'gemini',
      llmModel: 'gemini-2.0-flash',
      llmReasoningSummaryMode: 'off',
      llmReasoningEffort: 'off'
    });
    const run = created.run;

    repo.getWorkspaceAiSettings = async () => null;
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([
          { name: 'list_resources', server_id: 'acornops-target-agent', model_alias: 'list_resources', mcp_server_url: 'http://control-plane:8081/internal/v1/mcp', timeout_ms: 10000, capability: 'read', source: 'builtin', input_schema: { type: 'object' }, enabled: true },
          { name: 'get_resource', server_id: 'acornops-target-agent', model_alias: 'get_resource', mcp_server_url: 'http://control-plane:8081/internal/v1/mcp', timeout_ms: 10000, capability: 'read', source: 'builtin', input_schema: { type: 'object' }, enabled: true },
          { name: 'get_resource_logs', server_id: 'acornops-target-agent', model_alias: 'get_resource_logs', mcp_server_url: 'http://control-plane:8081/internal/v1/mcp', timeout_ms: 10000, capability: 'read', source: 'builtin', input_schema: { type: 'object' }, enabled: true }
        ]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: run.id }));
    const body = response.body as {
      scope: {
        type: string;
        workflow_id: string;
        workflow_run_id: string;
        workflow_session_id: string;
        target_id?: string;
        target_type?: string;
      };
      context: { endpoint: string };
      routing: { target_scoped: boolean; workflow_scoped: boolean };
      tools: { allowed_tools: string[]; gateway: { token: string } };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(body.scope.type, 'target');
    assert.equal(body.scope.workflow_id, 'cluster-triage');
    assert.equal(body.scope.workflow_run_id, run.workflowRunId);
    assert.equal(body.scope.workflow_session_id, created.execution.workflowSessionId);
    assert.equal(body.scope.target_id, 'cluster-primary');
    assert.equal(body.scope.target_type, 'kubernetes');
    assert.equal(body.context.endpoint, `/internal/v1/workflow-sessions/${created.execution.workflowSessionId}/context`);
    assert.equal(body.routing.target_scoped, true);
    assert.equal(body.routing.workflow_scoped, true);
    assert.deepEqual(body.tools.allowed_tools, [
      'get_resource',
      'get_resource_logs',
      'list_resources'
    ]);

    const claims = await gatewayTokenService.verifyRunScopeToken(body.tools.gateway.token);
    assert.equal(claims.scopeType, 'target');
    assert.equal(claims.targetId, 'cluster-primary');
    assert.equal(claims.targetType, 'kubernetes');
    assert.deepEqual(claims.contextGrants, []);
  });

  it('maps workspace AI credential status failures during bootstrap', async () => {
    repo.getRun = async () => createRun({ status: 'queued' });
    repo.getTarget = async () => createTarget();
    repo.getSession = async () => createSessionRecord();
    repo.getTargetAgentRegistration = async () => null;
    repo.getWorkspaceAiSettings = async () => null;
    repo.listTargetToolOverrides = async () => ({});
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify({ detail: 'llm-gateway unavailable' }), { status: 503 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(bootstrap, createRequest({ runId: 'run-1' }));

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to check workspace AI provider settings with llm-gateway',
        retryable: true
      }
    });
  });
});
