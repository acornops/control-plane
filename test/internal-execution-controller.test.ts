import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  bootstrap,
  normalizeToolCapability,
  summarizeRunEventCounts
} from '../src/controllers/internal-execution-controller.js';
import { agentGateway } from '../src/agent/ws-server.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { gatewayTokenService } from '../src/services/token-service.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { repo } from '../src/store/repository.js';
import {
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  resetWorkflowRepositoryForTests
} from '../src/store/repository-workflows.js';
import { runtime } from '../src/store/runtime.js';
import type { RunEvent } from '../src/types/domain.js';
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

const originalAppendRunEvents = repo.appendRunEvents;
const originalUpdateRun = repo.updateRun;
const originalUpsertAssistantFinalMessage = repo.upsertAssistantFinalMessage;
const originalWebhookEmit = webhooks.emit;

beforeEach(() => {
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
});

afterEach(() => {
  restoreControllerRegressionState();
  repo.appendRunEvents = originalAppendRunEvents;
  repo.updateRun = originalUpdateRun;
  repo.upsertAssistantFinalMessage = originalUpsertAssistantFinalMessage;
  webhooks.emit = originalWebhookEmit;
  runtime.clearRunEvents('run-1');
  resetWorkflowRepositoryForTests();
});

function createRunEvent(type: string, seq: number, payload: Record<string, unknown> = {}): RunEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    seq,
    ts: '2026-05-24T00:00:00.000Z',
    type,
    payload
  };
}

const VM_BOOTSTRAP_TOOLS = [
  {
    name: 'restart_service',
    mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
    timeout_ms: 10000,
    description: 'Restart a VM service',
    capability: 'write',
    version: 'v1',
    source: 'builtin',
    input_schema: { type: 'object' },
    enabled: true
  },
  {
    name: 'get_logs',
    mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
    timeout_ms: 10000,
    description: 'Read VM logs',
    capability: 'read',
    version: 'v1',
    source: 'builtin',
    input_schema: { type: 'object' },
    enabled: true
  }
];

function mockVmBootstrapToolFetch(): void {
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/tools?')) {
      return new Response(JSON.stringify(VM_BOOTSTRAP_TOOLS), { status: 200 });
    }
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

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
    const allowedTools = (response.body as { tools: { allowed_tools: string[] } }).tools.allowed_tools;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(allowedTools, ['get_logs', 'restart_service']);
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
    assert.deepEqual(tools.allowed_tools, ['get_logs']);
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
    assert.deepEqual(tools.allowed_tools, ['get_logs']);
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
          server_name: 'acornops-cluster-agent',
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
    assert.deepEqual(tools.allowed_tools, []);
    assert.deepEqual(tools.tool_specs, []);
  });

  it('bootstraps workflow runs with workspace scope and compiled grants', async () => {
    const workflow = getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = createWorkflowSession({
      workflow,
      createdBy: 'user-1',
      compiledAccessScope
    });
    const message = createWorkflowUserMessage({
      session,
      content: 'Triage the primary cluster.',
      inputs: { clusterId: 'cluster-primary', severity: 'high' }
    });
    const run = createWorkflowRun({
      session,
      message,
      workflowStepId: 'collect-cluster-signals',
      llmProvider: 'gemini',
      llmModel: 'gemini-2.0-flash',
      llmReasoningSummaryMode: 'off',
      llmReasoningEffort: 'default'
    });

    repo.getWorkspaceAiSettings = async () => null;
    mock.method(globalThis, 'fetch', async (input) => {
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
      };
      context: { endpoint: string };
      routing: { target_scoped: boolean; workflow_scoped: boolean };
      tools: { allowed_tools: string[]; gateway: { token: string } };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(body.scope.type, 'workspace');
    assert.equal(body.scope.workflow_id, 'cluster-triage');
    assert.equal(body.scope.workflow_run_id, run.workflowRunId);
    assert.equal(body.scope.workflow_session_id, session.id);
    assert.equal(body.scope.target_id, undefined);
    assert.equal(body.context.endpoint, `/internal/v1/workflow-sessions/${session.id}/context`);
    assert.equal(body.routing.target_scoped, false);
    assert.equal(body.routing.workflow_scoped, true);
    assert.deepEqual(body.tools.allowed_tools, [
      'events.search',
      'inventory.resources.list',
      'logs.summarize',
      'metrics.query'
    ]);

    const claims = await gatewayTokenService.verifyRunScopeToken(body.tools.gateway.token);
    assert.equal(claims.scopeType, 'workspace');
    assert.equal(claims.workflowId, 'cluster-triage');
    assert.equal(claims.workflowRunId, run.workflowRunId);
    assert.equal(claims.workflowSessionId, session.id);
    assert.deepEqual(claims.contextGrants, ['target_inventory', 'workspace_metadata']);
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

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to check workspace AI provider settings with llm-gateway',
        retryable: true
      }
    });
  });
});
