import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  listWorkflowOptions,
  updateWorkflow
} from '../src/controllers/workflows-controller.js';
import {
  BUILT_IN_ROLE_TEMPLATES,
  configureRoleTemplates
} from '../src/auth/authorization.js';
import { config } from '../src/config.js';
import type { PublicWorkflowDefinition } from '../src/types/workflows.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
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
        agentIds: ['agent-cluster-triage'],
        status: 'paused'
      }
    ));

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { workflow: { status: string } }).workflow.status, 'paused');
  });

  it('requires duplication before editing a system-provided workflow but permits deletion', async () => {
    installWorkspace('admin');

    const edited = await callController(updateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', agentIds: ['agent-cluster-triage'], name: 'Modified built-in' }
    ));
    assert.equal(edited.statusCode, 409);
    assert.equal((edited.body as { error: { code: string } }).error.code, 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE');

    const duplicated = await callController(duplicateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', name: 'Custom cluster triage' }
    ));
    assert.equal(duplicated.statusCode, 201);
    const draft = (duplicated.body as { workflow: PublicWorkflowDefinition }).workflow;
    assert.notEqual(draft.id, 'cluster-triage');
    assert.equal(draft.origin.type, 'manual');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.createdBy, 'user-1');

    const deleted = await callController(deleteWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 204);
  });

  it('requires manage_workflows before duplicating a workflow', async () => {
    installWorkspace('viewer');
    const response = await callController(duplicateWorkflow, createRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(response.statusCode, 403);
  });

  it('returns server option catalogs for governed workflow capability authoring', async () => {
    installWorkspace('admin');

    const response = await callController(listWorkflowOptions, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as {
      mcpServers: Array<{ value: string }>;
      mcpTools: Array<{ value: string }>;
      skills: Array<{ value: string }>;
      outputFormats: Array<{ value: string }>;
      runtimeLimits: Array<{ value: string }>;
      retentionPolicies: Array<{ value: string }>;
      sourceAvailability: Record<string, { status: string }>;
    };
    assert.ok(body.mcpServers.some((option) => option.value === 'acornops-target-agent'));
    assert.ok(body.mcpTools.some((option) => option.value === 'get_resource'));
    assert.ok(body.mcpTools.some((option) => option.value === 'reports.pdf.generate'));
    assert.ok(body.skills.some((option) => option.value === 'acornops-observability'));
    assert.ok(body.outputFormats.some((option) => option.value === 'pdf'));
    assert.deepEqual(body.runtimeLimits.map((option) => option.value), [
      String(Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)))
    ]);
    assert.deepEqual(body.retentionPolicies.map((option) => option.value), [
      String(config.TARGET_CHAT_REPORT_RETENTION_DAYS)
    ]);
  });

  it('lets owners create and delete workflow definitions', async () => {
    installWorkspace('owner');

    const compatibilityRequest = await callController(createWorkflow, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Rejected compatibility policy',
        prompt: 'This request must not create a workflow.',
        agentIds: ['agent-incident-reporter'],
        capabilityPolicy: { mode: 'read_only', maxRuntimeSeconds: 900 }
      }
    ));
    assert.equal(compatibilityRequest.statusCode, 400);
    assert.equal(
      (compatibilityRequest.body as { error: { code: string } }).error.code,
      'INVALID_REQUEST'
    );

    const created = await callController(createWorkflow, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Custom incident report',
        description: 'Generate a tailored incident report from selected chats.',
        prompt: 'Generate a tailored incident report from @chat[].',
        agentIds: ['agent-incident-reporter'],
        resourceRequirements: [{ type: 'chat', minimum: 1, maximum: 20, requiredOperations: ['read'] }],
        tags: ['incident', 'custom'],
        inputs: [
          { name: 'outputFormat', label: 'Output format', type: 'output_format', required: true, optionSource: 'outputFormats' }
        ],
        capabilityPolicy: {
          mode: 'read_only',
          restrictionMode: 'restrict',
          semanticCapabilityIds: ['incident.report.generate'],
          contextGrants: [],
          approvalRequirements: ['Before reading selected chats']
        }
      }
    ));

    assert.equal(created.statusCode, 201);
    const workflow = (created.body as { workflow: PublicWorkflowDefinition & Record<string, unknown> }).workflow;
    assert.equal(workflow.origin.type, 'manual');
    assert.deepEqual(workflow.agentIds, ['agent-incident-reporter']);
    assert.equal(workflow.executionMode, 'direct');
    assert.deepEqual(workflow.capabilityPolicy.semanticCapabilityIds, ['incident.report.generate']);
    assert.equal(
      workflow.capabilityPolicy.maxRuntimeSeconds,
      Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000))
    );
    assert.equal(workflow.capabilityPolicy.retentionDays, config.TARGET_CHAT_REPORT_RETENTION_DAYS);

    const defaulted = await callController(createWorkflow, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Defaulted workflow policy',
        prompt: 'Use server-owned defaults.',
        agentIds: ['agent-incident-reporter']
      }
    ));
    assert.equal(defaulted.statusCode, 201);
    const defaultedWorkflow = (defaulted.body as { workflow: PublicWorkflowDefinition }).workflow;
    assert.deepEqual(defaultedWorkflow.capabilityPolicy, {
      mode: 'read_only',
      restrictionMode: 'inherit',
      semanticCapabilityIds: [],
      contextGrants: ['workspace_metadata'],
      maxRuntimeSeconds: Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)),
      retentionDays: config.TARGET_CHAT_REPORT_RETENTION_DAYS,
      approvalRequirements: []
    });
    assert.deepEqual(defaultedWorkflow.requiredPermissions, ['read_workspace_data']);

    const coordinated = await callController(updateWorkflow, createRequest(
      { workflowId: workflow.id },
      {
        workspaceId: 'workspace-1',
        agentIds: ['agent-incident-reporter', 'agent-cluster-triage']
      }
    ));
    assert.equal(coordinated.statusCode, 200);
    assert.equal((coordinated.body as { workflow: PublicWorkflowDefinition }).workflow.executionMode, 'coordinated');

    const directAgain = await callController(updateWorkflow, createRequest(
      { workflowId: workflow.id },
      { workspaceId: 'workspace-1', agentIds: ['agent-incident-reporter'] }
    ));
    assert.equal(directAgain.statusCode, 200);
    assert.equal((directAgain.body as { workflow: PublicWorkflowDefinition }).workflow.executionMode, 'direct');

    const deleted = await callController(deleteWorkflow, createRequest(
      { workflowId: workflow.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 204);

  });

  it('rejects unknown fields through the strict workflow request schema', async () => {
    installWorkspace('owner');
    for (const field of ['workspaceId', 'executionMode']) {
      const response = await callController(createWorkflow, createRequest(
        { workspaceId: 'workspace-1' },
        {
          name: `Rejected ${field}`,
          prompt: 'Run the workflow.',
          agentIds: ['agent-cluster-triage'],
          [field]: field === 'executionMode' ? 'direct' : 'unsupported'
        }
      ));
      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'INVALID_REQUEST');
    }
  });

  it('rejects malformed nested workflow authoring fields instead of coercing them', async () => {
    installWorkspace('owner');
    const invalidBodies = [
      { capabilityPolicy: { mode: 'unsafe' } },
      { capabilityPolicy: { contextGrants: ['workspace_metadata', 42] } },
      { resourceRequirements: [{ type: 'chat', minimum: 1, maximum: 20, requiredOperations: ['read'], extra: true }] },
      { inputs: [{ name: 'format', label: 'Format', type: 'output_format', required: 'yes' }] },
      { tags: ['valid', 42] }
    ];

    for (const invalidBody of invalidBodies) {
      const response = await callController(createWorkflow, createRequest(
        { workspaceId: 'workspace-1' },
        {
          name: 'Rejected malformed workflow',
          prompt: 'Run the workflow.',
          agentIds: ['agent-cluster-triage'],
          ...invalidBody
        }
      ));
      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'INVALID_REQUEST');
    }
  });
});
