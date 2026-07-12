import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { decideRunApproval, getRun, listRunApprovals, listRunEvents } from '../src/controllers/runs-controller.js';
import {
  createSession,
  listSessions,
  postMessage,
  updateWorkflow
} from '../src/controllers/workflows-controller.js';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import {
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  getWorkflowRun,
  listWorkflowMessages,
  resetWorkflowRepositoryForTests
} from '../src/store/repository-workflows.js';
import { listAgentDefinitions, updateAgentDefinition } from '../src/store/repository-agents.js';
import type { WorkflowDefinitionForAccess } from '../src/types/workflows.js';
import {
  callController,
  createRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(() => {
  resetWorkflowRepositoryForTests();
  restoreControllerRegressionState();
});

describe('workflows controller', () => {
  it('creates and dispatches a workspace-scoped run from workflow chat', async () => {
    installWorkspace('operator');

    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      if (url === 'http://localhost:8080/api/v1/runs' && init?.method === 'POST') {
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
        content: 'Triage the selected cluster.',
        inputs: { clusterId: 'cluster-primary', severity: 'high' }
      }
    ));

    assert.equal(response.statusCode, 202);
    const body = response.body as {
      message_id: string;
      run_id: string;
      workflow_run_id: string;
      compiledAccessScope: { tools: string[]; contextGrants: string[] };
    };
    assert.ok(body.message_id);
    assert.ok(body.run_id);
    assert.ok(body.workflow_run_id);
    assert.deepEqual(body.compiledAccessScope.tools, [
      'events.search',
      'inventory.resources.list',
      'logs.summarize',
      'metrics.query'
    ]);
    assert.deepEqual(body.compiledAccessScope.contextGrants, ['target_inventory', 'workspace_metadata']);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const run = getWorkflowRun(body.run_id);
    assert.ok(run);
    assert.equal(run.status, 'running');
    assert.equal(run.workflowSessionId, sessionId);
    assert.equal(run.messageId, body.message_id);
    assert.equal(listWorkflowMessages(sessionId).length, 1);
    assert.equal(executionDispatches.length, 1);
    assert.deepEqual(executionDispatches[0], {
      contract_version: 1,
      scope_type: 'workspace',
      run_id: body.run_id,
      workspace_id: 'workspace-1',
      session_id: sessionId,
      message_id: body.message_id,
      workflow_id: 'cluster-triage',
      workflow_run_id: body.workflow_run_id,
      workflow_session_id: sessionId,
      workflow_step_id: 'collect-cluster-signals',
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

  it('exposes workflow approval gates through public run approval routes and records decisions', async () => {
    installWorkspace('admin');
    const workflow: WorkflowDefinitionForAccess = {
      id: 'read-write-workflow',
      workspaceId: 'workspace-1',
      version: 1,
      name: 'Read write workflow',
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
          enabledSkills: [],
          allowedMcpServers: ['workspace-registry'],
          allowedTools: ['registry.repositories.add'],
          contextGrants: ['workspace_metadata'],
          approvalRequired: true
        }
      ]
    };
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents: listAgentDefinitions('workspace-1'),
      actor: {
        userId: 'user-1',
        role: 'admin',
        permissions: getWorkspacePermissions('admin')
      },
      approvedContextGrants: ['workspace_metadata']
    });
    const session = createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const message = createWorkflowUserMessage({ session, content: 'Run write workflow' });
    const run = createWorkflowRun({ session, message, workflowStepId: 'write-registry' });

    const approvalsResponse = await callController(listRunApprovals, createRequest({ runId: run.id }));
    assert.equal(approvalsResponse.statusCode, 200);
    const approvals = approvalsResponse.body as Array<{ id: string; status: string; toolName: string; summary: string }>;
    assert.equal(approvals.length, 2);
    assert.equal(approvals[0].status, 'pending');
    assert.equal(approvals[0].toolName, 'workflow.approval_gate');
    assert.match(approvals[0].summary, /Before writing workspace registry/);

    const decidedResponse = await callController(decideRunApproval, createRequest(
      { runId: run.id, approvalId: approvals[0].id },
      { decision: 'approved' }
    ));
    assert.equal(decidedResponse.statusCode, 200);
    assert.equal((decidedResponse.body as { status: string; decision: string }).status, 'approved');
    assert.equal((decidedResponse.body as { decision: string }).decision, 'approved');

    const refreshedResponse = await callController(listRunApprovals, createRequest({ runId: run.id }));
    const refreshed = refreshedResponse.body as Array<{ id: string; status: string }>;
    assert.equal(refreshed.find((approval) => approval.id === approvals[0].id)?.status, 'approved');
  });

  it('lists workflow sessions with workspaceId from query on GET requests without a body', async () => {
    installWorkspace('operator');
    const workflow = getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents: listAgentDefinitions('workspace-1'),
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });

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
    const workflowOne = getWorkflowDefinition('workspace-1', 'cluster-triage');
    const workflowTwo = getWorkflowDefinition('workspace-2', 'cluster-triage');
    assert.ok(workflowOne);
    assert.ok(workflowTwo);
    const actor = {
      userId: 'user-1',
      role: 'operator',
      permissions: getWorkspacePermissions('operator')
    };
    const sessionOne = createWorkflowSession({
      workflow: workflowOne,
      createdBy: 'user-1',
      compiledAccessScope: compileWorkflowAccessScope({
        workflow: workflowOne,
        agents: listAgentDefinitions('workspace-1'),
        actor,
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      })
    });
    createWorkflowSession({
      workflow: workflowTwo,
      createdBy: 'user-1',
      compiledAccessScope: compileWorkflowAccessScope({
        workflow: workflowTwo,
        agents: listAgentDefinitions('workspace-2'),
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

  it('lets owners edit workflow categories and MCP scope before future sessions compile access', async () => {
    installWorkspace('owner');
    updateAgentDefinition('workspace-1', 'agent-release-coordinator', {
      mcpServers: ['github'], tools: ['github.repositories.read', 'github.branches.create']
    });

    const updateResponse = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        category: 'git-operations',
        enabledMcpServers: ['github'],
        enabledSkills: ['acornops-cross-repo-change'],
        policy: {
          mode: 'read_write',
          approvalRequirements: ['Before creating branches or pull requests']
        },
        steps: [
          {
            id: 'collect-cluster-signals',
            agentIds: ['agent-release-coordinator'],
            allowedMcpServers: ['github'],
            allowedTools: ['github.repositories.read', 'github.branches.create'],
            contextGrants: ['workspace_metadata'],
            approvalRequired: true
          }
        ]
      }
    ));

    assert.equal(updateResponse.statusCode, 200);
    const updated = (updateResponse.body as { workflow: WorkflowDefinitionForAccess }).workflow;
    assert.equal(updated.category, 'git-operations');
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.policy.approvalRequirements, ['Before creating branches or pull requests']);
    assert.deepEqual(updated.enabledMcpServers, ['github']);
    assert.deepEqual(updated.enabledSkills, ['acornops-cross-repo-change']);
    assert.deepEqual(updated.steps[0].allowedTools, ['github.branches.create', 'github.repositories.read']);
    assert.equal(updated.steps[0].approvalRequired, true);

    const createdSession = await callController(createSession, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata']
      }
    ));

    assert.equal(createdSession.statusCode, 201);
    const body = createdSession.body as {
      session: { workflowVersion: number };
      compiledAccessScope: { mode: string; mcpServers: string[]; tools: string[]; approvalGates: string[] };
    };
    assert.equal(body.session.workflowVersion, 2);
    assert.equal(body.compiledAccessScope.mode, 'read_write');
    assert.deepEqual(body.compiledAccessScope.mcpServers, ['github']);
    assert.deepEqual(body.compiledAccessScope.tools, ['github.branches.create', 'github.repositories.read']);
    assert.deepEqual(body.compiledAccessScope.approvalGates, ['Before creating branches or pull requests', 'Collect cluster signals']);
  });
});
