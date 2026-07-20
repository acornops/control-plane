import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { decideRunApproval, getRun, listRunApprovals, listRunEvents } from '../src/controllers/runs-controller.js';
import { config } from '../src/config.js';
import {
  createSession,
  listSessions,
  postMessage,
  updateWorkflow
} from '../src/controllers/workflows-controller.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import {
  createWorkflowDefinition,
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  getWorkflowRun,
  listWorkflowRunApprovals,
  listWorkflowMessages
} from '../src/store/repository-workflows.js';
import { getAgentDefinition, updateAgentMcpCapabilitySnapshot } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import { repo } from '../src/store/repository.js';
import { db } from '../src/infra/db.js';
import {
  callController,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflows controller', () => {
  async function compileScope(
    workflow: NonNullable<Awaited<ReturnType<typeof getWorkflowDefinition>>>,
    role: 'operator' | 'admin',
    approvedContextGrants: string[]
  ) {
    const entryAgent = await getAgentDefinition(workflow.workspaceId, workflow.entryAgentId);
    assert.ok(entryAgent);
    return compileWorkflowAccessScope({
      workflow,
      entryAgent,
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      targetRoute: workflow.capabilityPolicy.semanticCapabilityIds.includes('target.diagnostics.read')
        ? { id: workflow.workspaceId === 'workspace-1' ? 'cluster-1' : 'cluster-2', targetType: 'kubernetes' }
        : undefined,
      actor: { userId: 'user-1', role, permissions: getWorkspacePermissions(role) },
      approvedContextGrants
    });
  }

  it('creates and dispatches a target-scoped cluster triage run', async () => {
    installWorkspace('operator');

    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?') && url.includes('target_id=cluster-1')) {
        return new Response(JSON.stringify(['get_resource', 'get_resource_logs', 'list_resources'].map((name) => ({
          name,
          server_id: 'acornops-target-agent',
          model_alias: name,
          mcp_server_url: 'builtin://agentk',
          timeout_ms: 10_000,
          description: `${name} fixture`,
          capability: 'read',
          source: 'builtin',
          input_schema: {},
          enabled: true
        }))), { status: 200 });
      }
      if (url === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
        executionDispatches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    assert.equal(createdSession.statusCode, 201);
    const sessionId = (createdSession.body as { session: { id: string } }).session.id;

    const response = await callController(postMessage, createRequest(
      { sessionId },
      { content: 'Triage @target[Test Cluster].' }
    ));

    assert.equal(response.statusCode, 202);
    const body = response.body as {
      message_id: string;
      run_id: string;
      workflow_run_id: string;
      executionId: string;
      compiledAccessScope: { tools: string[]; contextGrants: string[] };
    };
    assert.ok(body.message_id);
    assert.ok(body.run_id);
    assert.ok(body.workflow_run_id);
    assert.deepEqual(body.compiledAccessScope.tools, [
      'get_resource',
      'get_resource_logs',
      'list_resources'
    ]);
    assert.deepEqual(body.compiledAccessScope.contextGrants, ['target_inventory', 'workspace_metadata']);

    assert.equal(body.executionId, body.workflow_run_id);
    const mutableConfig = config as typeof config & { AUTOMATION_RUNTIME_MODE: 'off' | 'shadow' | 'canary' | 'on' };
    const originalRuntimeMode = config.AUTOMATION_RUNTIME_MODE;
    mutableConfig.AUTOMATION_RUNTIME_MODE = 'on';
    try {
      assert.equal(await runAutomationOutboxTick(), 1);
    } finally {
      mutableConfig.AUTOMATION_RUNTIME_MODE = originalRuntimeMode;
    }

    const run = await getWorkflowRun(body.run_id);
    assert.ok(run);
    assert.equal(run.status, 'running');
    assert.equal(run.workflowSessionId, sessionId);
    assert.equal(run.messageId, body.message_id);
    assert.equal((await listWorkflowMessages(sessionId)).length, 1);
    assert.equal(executionDispatches.length, 1);
    assert.deepEqual(executionDispatches[0], {
      contract_version: 2,
      scope_type: 'target',
      run_id: body.run_id,
      workspace_id: 'workspace-1',
      session_id: sessionId,
      message_id: body.message_id,
      workflow_id: 'cluster-triage',
      workflow_run_id: body.workflow_run_id,
      workflow_execution_id: body.executionId,
      workflow_session_id: sessionId,
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      attempt_number: 1,
      idempotency_key: run.idempotencyKey,
      agent_id: 'agent-cluster-triage',
      agent_version: 2,
      requested_at: run.requestedAt
    });

    const sessionsResponse = await callController(listSessions, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(sessionsResponse.statusCode, 200);
    const sessionsBody = sessionsResponse.body as { items: Array<{ id: string; runs: Array<{ id: string }> }> };
    assert.equal(sessionsBody.items[0].id, sessionId);
    assert.equal(sessionsBody.items[0].runs[0].id, body.run_id);

    const runResponse = await callController(getRun, createRequest({ runId: body.run_id }));
    assert.equal(runResponse.statusCode, 200);
    assert.equal((runResponse.body as { workflowRunId: string }).workflowRunId, body.workflow_run_id);

    const eventsResponse = await callController(listRunEvents, createRequest({ runId: body.run_id }));
    assert.equal(eventsResponse.statusCode, 200);
    assert.deepEqual(eventsResponse.body, []);

    const approvalsResponse = await callController(listRunApprovals, createRequest({ runId: body.run_id }));
    assert.equal(approvalsResponse.statusCode, 200);
    assert.deepEqual(approvalsResponse.body, []);
  });

  it('creates an approval-gated incident report run from selected workspace chats', async () => {
    installWorkspace('operator');
    await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Payments incident');
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: [] }
    ));
    assert.equal(createdSession.statusCode, 201);
    const sessionId = (createdSession.body as { session: { id: string } }).session.id;

    const response = await callController(postMessage, createRequest(
      { sessionId },
      { content: 'Generate the incident report from @chat[Payments incident].' }
    ));

    assert.equal(response.statusCode, 202);
    const body = response.body as {
      run_id: string;
      status: string;
      compiledAccessScope: { tools: string[]; contextGrants: string[] };
    };
    assert.equal(body.status, 'waiting_for_approval');
    assert.deepEqual(body.compiledAccessScope.tools, [
      'prompt.resources.read',
      'reports.pdf.generate'
    ]);
    assert.deepEqual(body.compiledAccessScope.contextGrants, []);
    const run = await getWorkflowRun(body.run_id);
    assert.ok(run);
    assert.equal(run.targetId, undefined);
    assert.deepEqual((await listWorkflowRunApprovals(body.run_id)).map((approval) => approval.status), ['pending']);
  });

  it('exposes workflow approval gates through public run approval routes and records decisions', async () => {
    installWorkspace('admin');
    const workflow = await createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Read write workflow',
      prompt: 'Inspect the target and run the explicitly approved operation.',
      agentIds: ['agent-cluster-triage'],
      entryAgentId: 'agent-cluster-triage',
      requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
      capabilityPolicy: {
        mode: 'read_write',
        restrictionMode: 'restrict',
        semanticCapabilityIds: ['target.diagnostics.read'],
        contextGrants: ['workspace_metadata'],
        maxRuntimeSeconds: 900,
        retentionDays: 90,
        approvalRequirements: ['Before writing workspace registry']
      },
      createdBy: 'user-1'
    });
    const compiledAccessScope = await compileScope(workflow, 'admin', ['workspace_metadata']);
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const message = await createWorkflowUserMessage({ session, content: 'Run write workflow' });
    const run = await createWorkflowRun({ session, message });

    const approvalsResponse = await callController(listRunApprovals, createRequest({ runId: run.id }));
    assert.equal(approvalsResponse.statusCode, 200);
    const approvals = approvalsResponse.body as Array<{ id: string; status: string; toolName: string; summary: string }>;
    assert.equal(approvals.length, 1);
    const approval = approvals.find((candidate) => candidate.summary.includes('Before writing workspace registry'));
    assert.ok(approval);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.toolName, 'workflow.approval_gate');

    const decidedResponse = await callController(decideRunApproval, createRequest(
      { runId: run.id, approvalId: approval.id },
      { decision: 'approved' }
    ));
    assert.equal(decidedResponse.statusCode, 200);
    assert.equal((decidedResponse.body as { status: string; decision: string }).status, 'approved');
    assert.equal((decidedResponse.body as { decision: string }).decision, 'approved');

    const refreshedResponse = await callController(listRunApprovals, createRequest({ runId: run.id }));
    const refreshed = refreshedResponse.body as Array<{ id: string; status: string }>;
    assert.equal(refreshed.find((candidate) => candidate.id === approval.id)?.status, 'approved');
  });

  it('lists workflow sessions with workspaceId from query on GET requests without a body', async () => {
    installWorkspace('operator');
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const compiledAccessScope = await compileScope(workflow, 'operator', ['workspace_metadata', 'target_inventory']);
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });

    const req = createRequest({ workflowId: workflow.id });
    req.body = undefined as unknown as Record<string, unknown>;
    req.query = { workspaceId: 'workspace-1' };

    const response = await callController(listSessions, req);

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: Array<{ id: string }> };
    assert.equal(body.items[0].id, session.id);
  });

  it('does not leak same-id workflow sessions from another workspace', async () => {
    installWorkspace('operator');
    const workflowOne = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    const workflowTwo = await getWorkflowDefinition('workspace-2', 'cluster-triage');
    assert.ok(workflowOne);
    assert.ok(workflowTwo);
    const sessionOne = await createWorkflowSession({
      workflow: workflowOne,
      createdBy: 'user-1',
      compiledAccessScope: await compileScope(workflowOne, 'operator', ['workspace_metadata', 'target_inventory'])
    });
    await createWorkflowSession({
      workflow: workflowTwo,
      createdBy: 'user-1',
      compiledAccessScope: await compileScope(workflowTwo, 'operator', ['workspace_metadata', 'target_inventory'])
    });

    const response = await callController(listSessions, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: Array<{ id: string; workspaceId: string }> };
    assert.deepEqual(body.items.map((item) => item.id), [sessionOne.id]);
    assert.ok(body.items.every((item) => item.workspaceId === 'workspace-1'));
  });

  it('allows availability changes without opening system-provided workflow definitions for editing', async () => {
    installWorkspace('owner');

    const updateResponse = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        agentIds: ['agent-cluster-triage'],
        status: 'paused'
      }
    ));

    assert.equal(updateResponse.statusCode, 200);
    const workflow = (updateResponse.body as { workflow: { status: string; origin: { type: string } } }).workflow;
    assert.equal(workflow.status, 'paused');
    assert.equal(workflow.origin.type, 'template');
    });
  });

  it('returns bounded structured MCP readiness failures for workflow messages', async () => {
    installWorkspace('operator');
    await updateAgentMcpCapabilitySnapshot('workspace-1', 'agent-cluster-triage', {
      mcpServers: ['server-1'],
      mcpTools: [{ serverId: 'server-1', toolName: 'records.list' }],
      mcpInstallations: [{
        id: 'server-1', name: 'Records', url: 'https://mcp.example.test', enabled: true,
        credentialMode: 'individual', revision: 1, targetConstraints: { targetTypes: [], targetIds: [] },
        tools: [{
          serverId: 'server-1', toolName: 'records.list', alias: 'records_list',
          capability: 'read', enabled: true, reviewState: 'approved',
          riskLevel: 'read_only', autoAllowed: false
        }]
      }]
    }, 'user-1');
    await db.query(
      `UPDATE capability_routing_mappings
       SET agent_version=(SELECT version FROM agent_definitions WHERE workspace_id=$1 AND id=$2),
           mcp_tools=$3
       WHERE workspace_id=$1 AND agent_id=$2 AND capability_id='target.diagnostics.read'`,
      ['workspace-1', 'agent-cluster-triage', JSON.stringify([{
        serverId: 'server-1', toolName: 'records.list', alias: 'records_list', operation: 'read'
      }])]
    );
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/tools' && init?.method === 'GET') {
        return new Response(JSON.stringify([{
          name: 'list_resources',
          server_id: 'acornops-target-agent',
          model_alias: 'list_resources',
          mcp_server_url: 'builtin://agentk',
          timeout_ms: 10_000,
          capability: 'read',
          source: 'builtin',
          enabled: true
        }]), { status: 200 });
      }
      if (url.pathname === '/api/v1/internal/mcp/connections/readiness' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ready: false, failures: [{
          server_id: 'server-1', tool_name: 'records.list',
          code: 'MCP_REMOTE_DISABLED',
          server_url: 'https://must-not-leak.example/private',
          headers: { Authorization: 'Bearer must-not-leak' }
        }] }), { status: 200 });
      }
      return new Response(`unexpected request: ${url.pathname}`, { status: 500 });
    });

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory'] }
    ));
    assert.equal(createdSession.statusCode, 201);
    const sessionId = (createdSession.body as { session: { id: string } }).session.id;
    const response = await callController(postMessage, createRequest(
      { sessionId },
      { content: 'Triage @target[Test Cluster].' }
    ));

    assert.equal(response.statusCode, 409);
    const body = response.body as { error: { code: string; details: { readinessFailures: unknown[] } } };
    assert.equal(body.error.code, 'MCP_REMOTE_DISABLED');
    assert.deepEqual(body.error.details.readinessFailures, [{
      serverId: 'server-1', toolName: 'records.list', code: 'MCP_REMOTE_DISABLED'
    }]);
    assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
  });
