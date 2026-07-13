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
import { listAgentDefinitions } from '../src/store/repository-agents.js';
import { repo } from '../src/store/repository.js';
import type { WorkflowDefinitionForAccess } from '../src/types/workflows.js';
import {
  callController,
  createSessionRecord,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflows controller', () => {
  it('creates and dispatches a target-scoped cluster triage run', async () => {
    installWorkspace('operator');

    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
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
      {
        content: 'Triage @cluster[cluster].',
        inputs: { targetId: 'cluster-1', severity: 'high' },
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }
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
      contract_version: 1,
      scope_type: 'target',
      run_id: body.run_id,
      workspace_id: 'workspace-1',
      session_id: sessionId,
      message_id: body.message_id,
      workflow_id: 'cluster-triage',
      workflow_run_id: body.workflow_run_id,
      workflow_execution_id: body.executionId,
      workflow_session_id: sessionId,
      workflow_step_id: 'collect-cluster-signals',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      step_index: 0,
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
    const incidentChat = createSessionRecord({ id: 'incident-chat-1', title: 'Payments incident' });
    repo.getSession = async (sessionId) => sessionId === incidentChat.id ? incidentChat : null;
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['selected_chat_sessions'] }
    ));
    assert.equal(createdSession.statusCode, 201);
    const sessionId = (createdSession.body as { session: { id: string } }).session.id;

    const response = await callController(postMessage, createRequest(
      { sessionId },
      {
        content: 'Generate the incident report from @chat[Payments incident].',
        inputs: { chatSessionIds: [incidentChat.id] }
      }
    ));

    assert.equal(response.statusCode, 202);
    const body = response.body as {
      run_id: string;
      status: string;
      compiledAccessScope: { tools: string[]; contextGrants: string[] };
    };
    assert.equal(body.status, 'waiting_for_approval');
    assert.deepEqual(body.compiledAccessScope.tools, [
      'chat.sessions.read_selected',
      'reports.pdf.generate'
    ]);
    assert.deepEqual(body.compiledAccessScope.contextGrants, ['selected_chat_sessions']);
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
      category: 'cluster-triage',
      requiredPermissions: ['read_workspace_data', 'create_read_write_runs'],
      policy: {
        mode: 'read_write',
        maxRuntimeSeconds: 900,
        retentionDays: 90,
        approvalRequirements: ['Before writing workspace registry']
      },
      steps: [
        {
          id: 'write-registry',
          title: 'Write registry',
          requiredInputs: [],
          agentIds: ['agent-cluster-triage'],
          enabledSkills: [],
          allowedMcpServers: ['acornops-cluster-agent'],
          allowedTools: ['list_resources'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: true
        }
      ],
      createdBy: 'user-1'
    });
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents: await listAgentDefinitions('workspace-1'),
      actor: {
        userId: 'user-1',
        role: 'admin',
        permissions: getWorkspacePermissions('admin')
      },
      approvedContextGrants: ['workspace_metadata']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const message = await createWorkflowUserMessage({ session, content: 'Run write workflow' });
    const run = await createWorkflowRun({ session, message, workflowStepId: 'write-registry' });

    const approvalsResponse = await callController(listRunApprovals, createRequest({ runId: run.id }));
    assert.equal(approvalsResponse.statusCode, 200);
    const approvals = approvalsResponse.body as Array<{ id: string; status: string; toolName: string; summary: string }>;
    assert.equal(approvals.length, 2);
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
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents: await listAgentDefinitions('workspace-1'),
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
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
    const actor = {
      userId: 'user-1',
      role: 'operator',
      permissions: getWorkspacePermissions('operator')
    };
    const sessionOne = await createWorkflowSession({
      workflow: workflowOne,
      createdBy: 'user-1',
      compiledAccessScope: compileWorkflowAccessScope({
        workflow: workflowOne,
        agents: await listAgentDefinitions('workspace-1'),
        actor,
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      })
    });
    await createWorkflowSession({
      workflow: workflowTwo,
      createdBy: 'user-1',
      compiledAccessScope: compileWorkflowAccessScope({
        workflow: workflowTwo,
        agents: await listAgentDefinitions('workspace-2'),
        actor,
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      })
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

  it('lets owners edit the built-in MCP and skill gate before future sessions compile access', async () => {
    installWorkspace('owner');

    const updateResponse = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        category: 'cluster-triage',
        enabledMcpServers: ['acornops-cluster-agent'],
        enabledSkills: ['acornops-observability'],
        policy: {
          mode: 'read_only',
          approvalRequirements: []
        },
        steps: [
          {
            id: 'collect-cluster-signals',
            agentIds: ['agent-cluster-triage'],
            enabledSkills: ['acornops-observability'],
            allowedMcpServers: ['acornops-cluster-agent'],
            allowedTools: ['get_resource', 'list_resources'],
            contextGrants: ['workspace_metadata', 'target_inventory'],
            approvalRequired: false
          }
        ]
      }
    ));

    assert.equal(updateResponse.statusCode, 200);
    const updated = (updateResponse.body as { workflow: WorkflowDefinitionForAccess }).workflow;
    assert.equal(updated.category, 'cluster-triage');
    assert.equal(updated.version, 4);
    assert.deepEqual(updated.policy.approvalRequirements, []);
    assert.deepEqual(updated.enabledMcpServers, ['acornops-cluster-agent']);
    assert.deepEqual(updated.enabledSkills, ['acornops-observability']);
    assert.deepEqual(updated.steps[0].allowedTools, ['get_resource', 'list_resources']);
    assert.equal(updated.steps[0].approvalRequired, false);

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));

    assert.equal(createdSession.statusCode, 201);
    const body = createdSession.body as {
      session: { workflowVersion: number };
      compiledAccessScope: { mode: string; mcpServers: string[]; tools: string[]; approvalGates: string[] };
    };
    assert.equal(body.session.workflowVersion, 4);
    assert.equal(body.compiledAccessScope.mode, 'read_only');
    assert.deepEqual(body.compiledAccessScope.mcpServers, ['acornops-cluster-agent']);
    assert.deepEqual(body.compiledAccessScope.tools, ['get_resource', 'list_resources']);
    assert.deepEqual(body.compiledAccessScope.approvalGates, []);
  });
});
