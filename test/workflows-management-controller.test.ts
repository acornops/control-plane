import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import {
  createWorkflow,
  createWorkflowMcpServerForWorkspace,
  deleteWorkflow,
  listWorkflowMcpServerToolsForWorkspace,
  listWorkflowMcpServersForWorkspace,
  listWorkflowOptions,
  testWorkflowMcpServerConnectionForWorkspace,
  updateWorkflow,
  updateWorkflowMcpServerForWorkspace
} from '../src/controllers/workflows-controller.js';
import {
  BUILT_IN_ROLE_TEMPLATES,
  configureRoleTemplates
} from '../src/auth/authorization.js';
import type { WorkflowDefinitionForAccess } from '../src/types/workflows.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
  configureRoleTemplates(Object.values(BUILT_IN_ROLE_TEMPLATES));
});

after(closeAutomationDatabaseFixtures);

describe('workflows management controller', () => {
  it('requires manage_workflows before editing workflow definitions', async () => {
    installWorkspace('viewer');

    const response = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        steps: [
          {
            id: 'collect-cluster-signals',
            allowedMcpServers: ['github'],
            allowedTools: ['github.branches.create']
          }
        ]
      }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('allows workflow definition edits for roles with manage_workflows but not manage_mcp', async () => {
    configureRoleTemplates([
      ...Object.values(BUILT_IN_ROLE_TEMPLATES),
      {
        key: 'workflow-manager',
        displayName: 'Workflow Manager',
        description: 'Manages workflow definitions without MCP server mutation access.',
        kind: 'custom',
        capabilities: [
          'read_workspace_data',
          'manage_workflows',
          'create_sessions',
          'create_read_only_runs',
          'create_read_write_runs'
        ],
        protected: false,
        sortOrder: 900
      }
    ]);
    installWorkspace('workflow-manager');

    const response = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        status: 'paused'
      }
    ));

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { workflow: { status: string } }).workflow.status, 'paused');
  });

  it('rejects disabled server-provided workflow options', async () => {
    installWorkspace('admin');
    const disabled = await callController(updateWorkflowMcpServerForWorkspace, createRequest(
      { workspaceId: 'workspace-1', serverId: 'github' },
      { enabled: false }
    ));
    assert.equal(disabled.statusCode, 200);

    const created = await callController(createWorkflow, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Disabled MCP workflow',
        enabledMcpServers: ['github'],
        steps: [
          {
            id: 'read-repo',
            title: 'Read repo',
            allowedMcpServers: ['github'],
            allowedTools: ['github.repositories.read']
          }
        ]
      }
    ));

    assert.equal(created.statusCode, 400);
    assert.equal((created.body as { error: { code: string } }).error.code, 'WORKFLOW_OPTION_INVALID');
  });

  it('returns server option catalogs for governed workflow capability authoring', async () => {
    installWorkspace('admin');

    const response = await callController(listWorkflowOptions, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as {
      clusters: Array<{ value: string; label: string }>;
      mcpServers: Array<{ value: string }>;
      mcpTools: Array<{ value: string }>;
      skills: Array<{ value: string }>;
      outputFormats: Array<{ value: string }>;
      sourceAvailability: Record<string, { status: string }>;
    };
    assert.deepEqual(body.clusters.map((option) => option.value), ['cluster-1']);
    assert.equal(body.sourceAvailability.clusters.status, 'available');
    assert.ok(body.mcpServers.some((option) => option.value === 'acornops-target-agent'));
    assert.ok(body.mcpTools.some((option) => option.value === 'get_resource'));
    assert.ok(body.mcpTools.some((option) => option.value === 'reports.pdf.generate'));
    assert.ok(body.skills.some((option) => option.value === 'acornops-observability'));
    assert.ok(body.outputFormats.some((option) => option.value === 'pdf'));
  });

  it('lets owners create and delete user-authored workflows while preserving system templates', async () => {
    installWorkspace('owner');

    const created = await callController(createWorkflow, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Custom incident report',
        description: 'Generate a tailored incident report from selected chats.',
        category: 'incident-review',
        tags: ['incident', 'custom'],
        enabledMcpServers: [],
        enabledSkills: ['acornops-observability'],
        inputs: [
          { name: 'chatSessions', label: 'Incident chats', type: 'chat_session_list', required: true, optionSource: 'chatSessions' },
          { name: 'outputFormat', label: 'Output format', type: 'output_format', required: true, optionSource: 'outputFormats' }
        ],
        policy: {
          mode: 'read_only',
          maxRuntimeSeconds: 900,
          retentionDays: 90,
          approvalRequirements: ['Before reading selected chats']
        },
        steps: [
          {
            id: 'write-report',
            title: 'Write report',
            requiredInputs: ['chatSessions', 'outputFormat'],
            agentIds: ['agent-incident-reporter'],
            enabledSkills: [],
            allowedMcpServers: [],
            allowedTools: ['chat.sessions.read_selected', 'reports.pdf.generate'],
            contextGrants: ['selected_chat_sessions'],
            approvalRequired: true,
            outputArtifacts: [{ id: 'report', type: 'pdf', title: 'Incident report PDF', required: true }]
          }
        ]
      }
    ));

    assert.equal(created.statusCode, 201);
    const workflow = (created.body as { workflow: WorkflowDefinitionForAccess }).workflow;
    assert.equal(workflow.source, 'user');
    assert.equal(workflow.category, 'incident-review');
    assert.deepEqual(workflow.steps[0].outputArtifacts, [{ id: 'report', type: 'pdf', title: 'Incident report PDF', required: true }]);

    const deleted = await callController(deleteWorkflow, createRequest(
      { workflowId: workflow.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 204);

    const rejectedSystemDelete = await callController(deleteWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(rejectedSystemDelete.statusCode, 409);
    assert.equal((rejectedSystemDelete.body as { error: { code: string } }).error.code, 'SYSTEM_WORKFLOW_IMMUTABLE');
  });

  it('exposes workflow-scoped MCP server inventory, creation, connection test, and tool discovery', async () => {
    installWorkspace('admin');

    const initial = await callController(listWorkflowMcpServersForWorkspace, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(initial.statusCode, 200);
    assert.ok((initial.body as { items: Array<{ id: string }> }).items.some((server) => server.id === 'github'));

    const created = await callController(createWorkflowMcpServerForWorkspace, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Internal MCP',
        url: 'https://mcp.internal.example',
        enabled: true,
        auth: { type: 'bearer_token' },
        publicHeaders: { 'X-Team': 'ops' }
      }
    ));
    assert.equal(created.statusCode, 201);
    const server = (created.body as { server: { id: string; status: string; publicHeaders: Record<string, string> } }).server;
    assert.equal(server.status, 'not_checked');
    assert.equal(server.publicHeaders['X-Team'], 'ops');

    const tested = await callController(testWorkflowMcpServerConnectionForWorkspace, createRequest(
      { workspaceId: 'workspace-1', serverId: server.id }
    ));
    assert.equal(tested.statusCode, 200);
    assert.equal((tested.body as { status: string }).status, 'connected');

    const tools = await callController(listWorkflowMcpServerToolsForWorkspace, createRequest(
      { workspaceId: 'workspace-1', serverId: 'github' }
    ));
    assert.equal(tools.statusCode, 200);
    assert.ok((tools.body as { items: Array<{ name: string; capability: string }> }).items.some((tool) => (
      tool.name === 'github.prs.create' && tool.capability === 'write'
    )));
  });
});
