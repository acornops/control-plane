import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { bootstrap, summarizeRunEventCounts } from '../src/controllers/internal-execution-controller.js';
import { createToolApproval } from '../src/controllers/internal-approval-controller.js';
import { normalizeToolCapability } from '../src/services/target-run-tool-resolution.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { gatewayTokenService } from '../src/services/token-service.js';
import { repo } from '../src/store/repository.js';
import { RunToolApprovalConflictError } from '../src/store/repository-run-approvals.js';
import { runtime } from '../src/store/runtime.js';
import {
  callController,
  createApproval,
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

describe('VM approvals during asynchronous dispatch', () => {
  for (const scenario of [
    { mode: 'read_write', serverId: '00000000-0000-4000-8000-000000000001', status: 201, code: undefined },
    { mode: 'read_write', serverId: '00000000-0000-4000-8000-000000000001', status: 409, code: 'APPROVAL_IDEMPOTENCY_CONFLICT' },
    { mode: 'read_only', serverId: '00000000-0000-4000-8000-000000000001', status: 400, code: 'READ_WRITE_REQUIRED' },
    { mode: 'read_write', serverId: 'ungranted-server', status: 400, code: 'MCP_TOOL_REF_NOT_GRANTED' }
  ] as const) {
    it(`keeps ${scenario.mode} and exact-tool checks for ${scenario.serverId}: ${scenario.status}`, async () => {
      repo.getRun = async () => createRun({
        status: 'dispatching', targetId: 'vm-1', targetType: 'virtual_machine', toolAccessMode: scenario.mode
      });
      repo.getTarget = async () => createTarget({ id: 'vm-1', targetType: 'virtual_machine' });
      repo.getSession = async () => createSessionRecord({ targetId: 'vm-1', targetType: 'virtual_machine' });
      repo.getTargetAgentRegistration = async () => ({
        targetId: 'vm-1', targetType: 'virtual_machine', workspaceId: 'workspace-1',
        agentKeyHash: 'hash', keyVersion: 1, capabilities: ['read', 'write']
      });
      repo.listTargetToolOverrides = async () => ({});
      mockVmBootstrapToolFetch();
      const conflict = scenario.status === 409;
      const persist = mock.method(repo, 'createRunToolApproval', async () => {
        if (conflict) throw new RunToolApprovalConflictError();
        return createApproval({ targetId: 'vm-1', targetType: 'virtual_machine', toolName: 'restart_service' });
      });
      const activity = mock.method(repo, 'insertTargetChatActivityEvent');
      const webhook = mock.method(webhooks, 'emit');
      const response = await callController(createToolApproval, createRequest({ runId: 'run-1' }, {
        toolCallId: 'call-2', toolName: 'restart_service',
        toolRef: { serverId: scenario.serverId, toolName: 'restart_service' },
        arguments: { unit: 'cron.service', expected_active_state: 'active', expected_sub_state: 'running' },
        continuation: { schema_version: 1, pending_tool_call: { call_id: 'call-2' } }
      }));
      assert.equal(response.statusCode, scenario.status);
      if (scenario.code) {
        assert.equal((response.body as { error: { code: string } }).error.code, scenario.code);
        assert.equal(persist.mock.callCount(), conflict ? 1 : 0);
        if (conflict) {
          assert.deepEqual(response.body, { error: {
            code: 'APPROVAL_IDEMPOTENCY_CONFLICT',
            message: 'The tool-call ID was already used with a different approval request.', retryable: false
          } });
          assert.equal(activity.mock.callCount(), 0);
          assert.equal(webhook.mock.callCount(), 0);
        }
      } else {
        assert.equal(persist.mock.callCount(), 1);
        assert.equal((response.body as { status: string }).status, 'pending');
      }
    });
  }
});

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

  it('bootstraps an explicit target scope and allows supported VM write tools', async () => {
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
    const body = response.body as {
      scope: {
        type: string;
        workspace_id: string;
        target_id: string;
        target_type: string;
        session_id: string;
        run_id: string;
        user_id: string;
      };
      tools: {
        allowed_tools: string[];
        native_tools: Array<{ id: string }>;
        platform_functions: Array<{ id: string; model_alias: string }>;
        tool_specs: Array<{ name: string }>;
        gateway: { token: string };
      };
    };
    const tools = body.tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.scope, {
      type: 'target',
      workspace_id: 'workspace-1',
      target_id: 'vm-1',
      target_type: 'virtual_machine',
      session_id: 'session-1',
      run_id: 'run-1',
      user_id: 'user-1'
    });
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'restart_service', 'acornops_create_document']);
    assert.deepEqual(tools.native_tools, [{
      id: 'web_search',
      config: { domainFilters: { allowedDomains: [], blockedDomains: [] } }
    }]);
    assert.deepEqual(tools.platform_functions, [
      { id: 'documents.create', model_alias: 'acornops_create_document' }
    ]);
    assert.ok(tools.tool_specs.some((tool) => tool.name === 'acornops_create_document'));
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
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'acornops_create_document']);
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
    assert.deepEqual(tools.allowed_tools, ['query_logs', 'acornops_create_document']);
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
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        artifactPolicy: 'never' as const
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
    assert.deepEqual(tools.allowed_tools, ['acornops_create_document']);
    assert.deepEqual((tools.tool_specs as Array<{ name: string }>).map((tool) => tool.name), [
      'acornops_create_document'
    ]);
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
