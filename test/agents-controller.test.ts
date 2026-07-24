import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  createAgent,
  createAgentVersion,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgentVersions,
  listAgents,
  restoreAgentVersion,
  updateAgent,
} from '../src/controllers/agents-controller.js';
import { repo } from '../src/store/repository.js';
import { createWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { closeAutomationDatabaseFixtures, installAutomationTemplateFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('agents controller', () => {
  it('returns a truthful empty state in a fresh workspace', async () => {
    installWorkspace('viewer');

    const response = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: unknown[] };
    assert.deepEqual(body.items, []);
  });

  it('attributes manually created agents to their actual creator', async () => {
    installWorkspace('admin');
    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Manual specialist', instructions: 'Inspect only granted evidence.' }
    ));
    assert.equal(created.statusCode, 201);

    const response = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: Array<{ origin: { type: string }; ownerUserId: string; createdBy: string }> };
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.items[0].origin, { type: 'manual' });
    assert.equal(body.items[0].ownerUserId, 'user-1');
    assert.equal(body.items[0].createdBy, 'user-1');
  });

  it('can include disabled agents for management views without changing the default list', async () => {
    installWorkspace('admin');

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Disableable specialist', instructions: 'Use only reviewed capabilities.' }
    ));
    const agentId = (created.body as { agent: { id: string } }).agent.id;

    const disabled = await callController(updateAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1', status: 'disabled' }
    ));
    assert.equal(disabled.statusCode, 200);

    const activeOnly = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(activeOnly.statusCode, 200);
    assert.ok(!(activeOnly.body as { items: Array<{ id: string }> }).items.some((agent) => agent.id === agentId));

    const request = createRequest({ workspaceId: 'workspace-1' });
    request.query = { includeInactive: 'true' };
    const allAgents = await callController(listAgents, request);
    assert.equal(allAgents.statusCode, 200);
    assert.ok((allAgents.body as { items: Array<{ id: string; status: string }> }).items.some((agent) => agent.id === agentId && agent.status === 'disabled'));
  });

  it('requires manage_agents before duplicating an agent', async () => {
    installWorkspace('admin');
    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Protected specialist', instructions: 'Inspect assigned work.' }
    ));
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    installWorkspace('viewer');
    const response = await callController(duplicateAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(response.statusCode, 403);
  });

  it('requires duplication before editing or versioning a system-provided Agent and uses normal deletion dependencies', async () => {
    installWorkspace('admin');
    await installAutomationTemplateFixtures(['workspace-1']);

    const edited = await callController(updateAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1', instructions: 'Replace system instructions.' }
    ));
    assert.equal(edited.statusCode, 409);
    assert.equal((edited.body as { error: { code: string } }).error.code, 'SYSTEM_AGENT_DEFINITION_IMMUTABLE');

    const availability = await callController(updateAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1', status: 'disabled' }
    ));
    assert.equal(availability.statusCode, 200);
    assert.equal((availability.body as { agent: { status: string } }).agent.status, 'disabled');

    const versioned = await callController(createAgentVersion, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(versioned.statusCode, 409);
    assert.equal((versioned.body as { error: { code: string } }).error.code, 'SYSTEM_AGENT_DEFINITION_IMMUTABLE');

    const deleted = await callController(deleteAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 409);
    assert.equal((deleted.body as { error: { code: string } }).error.code, 'AGENT_ASSIGNED_TO_WORKFLOWS');
    assert.deepEqual(
      (deleted.body as { error: { details: { workflows: Array<{ id: string; relation: string }> } } }).error.details.workflows,
      [{ id: 'cluster-triage', name: 'Target diagnostics', relation: 'selected_agent' }]
    );

    const duplicated = await callController(duplicateAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1', name: 'Custom diagnostics' }
    ));
    assert.equal(duplicated.statusCode, 201);
    assert.equal((duplicated.body as { agent: { origin: { type: string }; status: string } }).agent.origin.type, 'manual');
    assert.equal((duplicated.body as { agent: { origin: { type: string }; status: string } }).agent.status, 'draft');
  });

  it('enriches agent responses with workflow usage and derived capability rows', async () => {
    installWorkspace('admin');
    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Cluster specialist', instructions: 'Inspect the selected cluster.',
        contextGrants: ['workspace_metadata'],
        targetScope: { type: 'selected_target', targetTypes: ['kubernetes'] },
        semanticCapabilityIds: ['target.diagnostics.read']
      }
    ));
    assert.equal(created.statusCode, 201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    await createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Cluster incident workflow',
      prompt: 'Inspect the selected cluster.',
      agentIds: [agentId],
      requiredPermissions: ['create_read_only_runs'],
      capabilityPolicy: {
        mode: 'read_only', restrictionMode: 'restrict', semanticCapabilityIds: ['target.diagnostics.read'],
        contextGrants: [], maxRuntimeSeconds: 300, retentionDays: 7, approvalRequirements: []
      },
      createdBy: 'user-1'
    });

    const listed = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listed.statusCode, 200);
    const listAgent = (listed.body as {
      items: Array<{ id: string; workflowsUsingAgent?: string[]; capabilities?: Array<{ source: string; resourceScope: string }> }>;
    }).items.find((agent) => agent.id === agentId);
    assert.ok(listAgent);
    assert.ok(listAgent.workflowsUsingAgent?.includes('Cluster incident workflow'));
    assert.ok(listAgent.capabilities?.some((capability) => capability.source === 'target' && capability.resourceScope === 'kubernetes'));
    assert.ok(listAgent.capabilities?.some((capability) => capability.source === 'context' && capability.resourceScope === 'workspace_metadata'));

    const fetched = await callController(getAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.ok((fetched.body as { agent: { workflowsUsingAgent?: string[] } }).agent.workflowsUsingAgent?.includes('Cluster incident workflow'));
  });

  it('requires manage_agents before creating custom agents', async () => {
    installWorkspace('viewer');

    const response = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Release helper', instructions: 'Prepare release notes.' }
    ));

    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });

  it('creates, updates, and versions custom agents for managers', async () => {
    installWorkspace('admin');
    const auditEvents: string[] = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push(event.eventType);
      return {
        id: `audit-event-${auditEvents.length}`,
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: event.actorUserId || 'user-1' },
        object: { type: event.objectType, ...(event.objectId ? { id: event.objectId } : {}) },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-05-24T00:00:00.000Z'
      };
    };

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Release helper',
        description: 'Coordinates release checks.',
        instructions: 'Prepare release notes and ask before write tools.',
        providerType: 'internal',
        contextGrants: ['workspace_metadata'],
        approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true }
      }
    ));

    assert.equal(created.statusCode, 201);
    const agent = (created.body as { agent: { id: string; version: number; status: string; providerType: string; trustPolicy: { level: string; allowExternalData: boolean } } }).agent;
    assert.equal(agent.version, 1);
    assert.equal(agent.status, 'active');
    assert.equal(agent.providerType, 'internal');
    assert.deepEqual(agent.trustPolicy, { level: 'restricted', allowExternalData: false });

    const patched = await callController(updateAgent, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        instructions: 'Prepare release notes and draft a PR plan.'
      }
    ));
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.body as { agent: { version: number } }).agent.version, 2);

    const version = await callController(createAgentVersion, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(version.statusCode, 201);
    assert.equal((version.body as { version: { version: number } }).version.version, 2);

    const versions = await callController(listAgentVersions, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(versions.statusCode, 200);
    assert.equal((versions.body as { items: Array<{ version: number }> }).items.length, 1);
    assert.equal((versions.body as { items: Array<{ version: number }> }).items[0].version, 2);
    const versionId = (versions.body as { items: Array<{ id: string }> }).items[0].id;

    const restored = await callController(restoreAgentVersion, createRequest(
      { agentId: agent.id, versionId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(restored.statusCode, 200);
    assert.equal((restored.body as { agent: { version: number } }).agent.version, 3);

    assert.deepEqual(auditEvents, [
      'agent.definition_created.v1',
      'agent.definition_updated.v1',
      'agent.version_snapshot_created.v1',
      'agent.version_restored.v1'
    ]);

    const fetched = await callController(getAgent, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.body as { agent: { id: string; providerType: string } }).agent.id, agent.id);
    assert.equal((fetched.body as { agent: { providerType: string } }).agent.providerType, 'internal');
  });

  it('lists agent version snapshots newest first', async () => {
    installWorkspace('admin');

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Versioned helper', instructions: 'Handle versioned work.' }
    ));
    assert.equal(created.statusCode, 201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;

    await callController(createAgentVersion, createRequest({ agentId }, { workspaceId: 'workspace-1' }));
    await callController(updateAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1', instructions: 'Handle versioned work with more context.' }
    ));
    await callController(createAgentVersion, createRequest({ agentId }, { workspaceId: 'workspace-1' }));

    const versions = await callController(listAgentVersions, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));

    assert.equal(versions.statusCode, 200);
    assert.deepEqual((versions.body as { items: Array<{ version: number }> }).items.map((version) => version.version), [2, 1]);
  });

  it('deletes only unassigned custom agents', async () => {
    installWorkspace('admin');
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/servers' && init?.method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Temporary helper', instructions: 'Handle temporary work.' }
    ));
    assert.equal(created.statusCode, 201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;

    const deleted = await callController(deleteAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deleted.statusCode, 204);

    const fetched = await callController(getAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 404);
  });

  it('blocks deleting agents still assigned to workflows', async () => {
    installWorkspace('admin');

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Assigned helper', instructions: 'Handle assigned work.' }
    ));
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    await createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Assigned helper workflow',
      prompt: 'Run the assigned helper.',
      agentIds: [agentId],
      requiredPermissions: ['create_read_only_runs'],
      capabilityPolicy: {
        mode: 'read_only', restrictionMode: 'restrict', semanticCapabilityIds: [], contextGrants: [],
        maxRuntimeSeconds: 300, retentionDays: 7, approvalRequirements: []
      },
      createdBy: 'user-1'
    });

    const assignedDelete = await callController(deleteAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(assignedDelete.statusCode, 409);
    assert.equal((assignedDelete.body as { error: { code: string } }).error.code, 'AGENT_ASSIGNED_TO_WORKFLOWS');
  });

  it('rejects custom agents that request unknown server-owned capabilities', async () => {
    installWorkspace('admin');

    const response = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Uncataloged helper',
        instructions: 'Use tools that are not registered.',
        mcpServers: ['missing-server'],
        tools: ['missing.tool'],
        skills: ['missing-skill'],
        contextGrants: ['missing_context']
      }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'AGENT_CAPABILITY_ROUTE_REQUIRED');
  });
});
