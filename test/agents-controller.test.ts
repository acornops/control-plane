import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createAgent,
  createAgentTrigger,
  createAgentVersion,
  deleteAgent,
  deleteAgentTrigger,
  getAgent,
  listAgentActivity,
  listAgentVersions,
  listAgents,
  restoreAgentVersion,
  testAgent,
  updateAgent,
  updateAgentTrigger
} from '../src/controllers/agents-controller.js';
import { repo } from '../src/store/repository.js';
import { resetAgentRepositoryForTests } from '../src/store/repository-agents.js';
import { createWorkflowDefinition, resetWorkflowRepositoryForTests } from '../src/store/repository-workflows.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(() => {
  resetAgentRepositoryForTests();
  resetWorkflowRepositoryForTests();
  restoreControllerRegressionState();
});

describe('agents controller', () => {
  it('lets data-read users list active system agents', async () => {
    installWorkspace('viewer');

    const response = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: Array<{ id: string; source: string; status: string }> };
    assert.ok(body.items.some((agent) => agent.id === 'agent-cluster-triage' && agent.source === 'system'));
    assert.ok(body.items.every((agent) => agent.status === 'active'));
  });

  it('keeps only the workflow orchestrator owned by the system actor', async () => {
    installWorkspace('viewer');

    const response = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 200);
    const body = response.body as { items: Array<{ id: string; ownerUserId: string }> };
    const ownerByAgentId = new Map(body.items.map((agent) => [agent.id, agent.ownerUserId]));
    assert.equal(ownerByAgentId.get('agent-workflow-orchestrator'), 'system');
    assert.equal(ownerByAgentId.get('agent-cluster-triage'), 'user-1');
    assert.equal(ownerByAgentId.get('agent-release-coordinator'), 'user-1');
    assert.equal(ownerByAgentId.get('agent-incident-reporter'), 'user-1');
  });

  it('can include disabled agents for management views without changing the default list', async () => {
    installWorkspace('admin');

    const disabled = await callController(updateAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1', status: 'disabled' }
    ));
    assert.equal(disabled.statusCode, 200);

    const activeOnly = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(activeOnly.statusCode, 200);
    assert.ok(!(activeOnly.body as { items: Array<{ id: string }> }).items.some((agent) => agent.id === 'agent-cluster-triage'));

    const request = createRequest({ workspaceId: 'workspace-1' });
    request.query = { includeInactive: 'true' };
    const allAgents = await callController(listAgents, request);
    assert.equal(allAgents.statusCode, 200);
    assert.ok((allAgents.body as { items: Array<{ id: string; status: string }> }).items.some((agent) => agent.id === 'agent-cluster-triage' && agent.status === 'disabled'));
  });

  it('enriches agent responses with workflow usage and derived capability rows', async () => {
    installWorkspace('admin');
    createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Cluster incident workflow',
      category: 'incident-review',
      requiredPermissions: ['create_read_only_runs'],
      policy: { mode: 'read_only', maxRuntimeSeconds: 300, retentionDays: 7, approvalRequirements: [] },
      steps: [{
        id: 'triage',
        title: 'Triage',
        requiredInputs: [],
        agentIds: ['agent-cluster-triage'],
        enabledSkills: [],
        allowedMcpServers: [],
        allowedTools: [],
        contextGrants: [],
        approvalRequired: false
      }],
      createdBy: 'user-1'
    });

    const listed = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listed.statusCode, 200);
    const listAgent = (listed.body as {
      items: Array<{ id: string; workflowsUsingAgent?: string[]; capabilities?: Array<{ source: string; resourceScope: string }> }>;
    }).items.find((agent) => agent.id === 'agent-cluster-triage');
    assert.ok(listAgent);
    assert.ok(listAgent.workflowsUsingAgent?.includes('Cluster incident workflow'));
    assert.ok(listAgent.capabilities?.some((capability) => capability.source === 'target' && capability.resourceScope === 'kubernetes'));
    assert.ok(listAgent.capabilities?.some((capability) => capability.source === 'context' && capability.resourceScope === 'target_inventory'));
    assert.ok(listAgent.capabilities?.some((capability) => capability.source === 'builtin_tool' && capability.resourceScope === 'events.search'));

    const fetched = await callController(getAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
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

  it('creates, updates, versions, tests, and triggers custom agents for managers', async () => {
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
        providerType: 'external',
        mcpServers: ['github'],
        tools: ['github.repositories.read', 'github.prs.create'],
        skills: ['acornops-cross-repo-change'],
        contextGrants: ['workspace_metadata'],
        approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true }
      }
    ));

    assert.equal(created.statusCode, 201);
    const agent = (created.body as { agent: { id: string; version: number; status: string; providerType: string; trustPolicy: { level: string; allowExternalData: boolean } } }).agent;
    assert.equal(agent.version, 1);
    assert.equal(agent.status, 'active');
    assert.equal(agent.providerType, 'external');
    assert.deepEqual(agent.trustPolicy, { level: 'restricted', allowExternalData: false });

    const patched = await callController(updateAgent, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        instructions: 'Prepare release notes and draft a PR plan.',
        tools: ['github.repositories.read']
      }
    ));
    assert.equal(patched.statusCode, 200);
    assert.equal((patched.body as { agent: { version: number; tools: string[] } }).agent.version, 2);
    assert.deepEqual((patched.body as { agent: { tools: string[] } }).agent.tools, ['github.repositories.read']);

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
    assert.equal((restored.body as { agent: { version: number; tools: string[] } }).agent.version, 3);
    assert.deepEqual((restored.body as { agent: { tools: string[] } }).agent.tools, ['github.repositories.read']);

    const trigger = await callController(createAgentTrigger, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        type: 'schedule',
        name: 'Weekday release scan',
        schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' }
      }
    ));
    assert.equal(trigger.statusCode, 201);
    const triggerId = (trigger.body as { trigger: { id: string; enabled: boolean } }).trigger.id;
    assert.equal((trigger.body as { trigger: { enabled: boolean } }).trigger.enabled, true);

    const disabledTrigger = await callController(updateAgentTrigger, createRequest(
      { agentId: agent.id, triggerId },
      { workspaceId: 'workspace-1', enabled: false }
    ));
    assert.equal(disabledTrigger.statusCode, 200);
    assert.equal((disabledTrigger.body as { trigger: { enabled: boolean } }).trigger.enabled, false);

    const testRun = await callController(testAgent, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata'],
        inputContext: { release: 'v1.2.3' }
      }
    ));
    assert.equal(testRun.statusCode, 202);
    assert.equal((testRun.body as { compiledScope: { agentId: string } }).compiledScope.agentId, agent.id);

    const activity = await callController(listAgentActivity, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(activity.statusCode, 200);
    assert.equal((activity.body as { items: Array<{ triggerId?: string }> }).items.length, 1);

    const deletedTrigger = await callController(deleteAgentTrigger, createRequest(
      { agentId: agent.id, triggerId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(deletedTrigger.statusCode, 204);
    assert.deepEqual(auditEvents, [
      'agent.definition_created.v1',
      'agent.definition_updated.v1',
      'agent.version_snapshot_created.v1',
      'agent.version_restored.v1',
      'agent.trigger_created.v1',
      'agent.trigger_updated.v1',
      'agent.trigger_deleted.v1'
    ]);

    const fetched = await callController(getAgent, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.body as { agent: { id: string; providerType: string } }).agent.id, agent.id);
    assert.equal((fetched.body as { agent: { providerType: string } }).agent.providerType, 'external');
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

  it('blocks deleting system agents or agents still assigned to workflows', async () => {
    installWorkspace('admin');

    const systemDelete = await callController(deleteAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(systemDelete.statusCode, 409);
    assert.equal((systemDelete.body as { error: { code: string } }).error.code, 'SYSTEM_AGENT_IMMUTABLE');

    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Assigned helper', instructions: 'Handle assigned work.' }
    ));
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Assigned helper workflow',
      category: 'release-operations',
      requiredPermissions: ['create_read_only_runs'],
      policy: { mode: 'read_only', maxRuntimeSeconds: 300, retentionDays: 7, approvalRequirements: [] },
      steps: [{
        id: 'assigned-step',
        title: 'Assigned step',
        requiredInputs: [],
        agentIds: [agentId],
        enabledSkills: [],
        allowedMcpServers: [],
        allowedTools: [],
        contextGrants: [],
        approvalRequired: false
      }],
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
    assert.equal((response.body as { error: { code: string } }).error.code, 'AGENT_OPTION_INVALID');
  });
});
