import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgents,
  updateAgent,
} from '../src/controllers/agents-controller.js';
import { provisionStarterAutomation } from '../src/services/automation-templates.js';
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
  it('keeps starter Agent provenance stable across renames without classifying lookalike custom Agents', async () => {
    installWorkspace('admin');
    const seeded = await provisionStarterAutomation({
      workspaceId: 'workspace-1',
      installedBy: 'user-1'
    });
    const kubernetesAgentId = seeded.installation.recordIds['agent:kubernetesAgent'];
    const renamed = await callController(updateAgent, createRequest(
      { agentId: kubernetesAgentId },
      { workspaceId: 'workspace-1', name: 'Production cluster specialist' }
    ));
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(
      (renamed.body as { agent: { templateRef?: { templateId: string; recordKey: string } } }).agent.templateRef,
      { templateId: 'acornops-starter', recordKey: 'agent:kubernetesAgent' }
    );

    const custom = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Kubernetes Agent', instructions: 'Inspect only explicitly granted evidence.' }
    ));
    assert.equal(custom.statusCode, 201);
    const customAgentId = (custom.body as { agent: { id: string } }).agent.id;

    const response = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(response.statusCode, 200);
    const agents = (response.body as {
      items: Array<{ id: string; name: string; templateRef?: { templateId: string; recordKey: string } }>;
    }).items;
    assert.deepEqual(agents.find((agent) => agent.id === kubernetesAgentId)?.templateRef, {
      templateId: 'acornops-starter',
      recordKey: 'agent:kubernetesAgent'
    });
    assert.equal(agents.find((agent) => agent.id === customAgentId)?.templateRef, undefined);
  });

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
    const body = response.body as { items: Array<{ ownerUserId: string; createdBy: string }> };
    assert.equal(body.items.length, 1);
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
    assert.equal(disabled.statusCode, 200, JSON.stringify(disabled.body));

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

  it('duplicates a workspace Agent as an independent draft', async () => {
    installWorkspace('admin');
    await installAutomationTemplateFixtures(['workspace-1']);

    const duplicated = await callController(duplicateAgent, createRequest(
      { agentId: 'agent-cluster-triage' },
      { workspaceId: 'workspace-1', name: 'Custom diagnostics' }
    ));
    assert.equal(duplicated.statusCode, 201);
    const duplicatedAgent = (duplicated.body as { agent: { avatarEmoji: string; status: string } }).agent;
    assert.equal(duplicatedAgent.status, 'draft');
    assert.equal(duplicatedAgent.avatarEmoji, '🔎');
  });

  it('returns Agent capabilities without reverse Workflow projections', async () => {
    installWorkspace('admin');
    const created = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      {
        name: 'Cluster specialist', instructions: 'Inspect the selected cluster.',
        semanticCapabilityIds: ['infrastructure.diagnostics.read']
      }
    ));
    assert.equal(created.statusCode, 201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;
    await createWorkflowDefinition({
      workspaceId: 'workspace-1',
      name: 'Cluster incident workflow',
      prompt: 'Inspect the selected cluster.',
      agentIds: [agentId],
      createdBy: 'user-1'
    });

    const listed = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listed.statusCode, 200);
    const listAgent = (listed.body as {
      items: Array<{ id: string; semanticCapabilityIds: string[]; capabilities?: Array<{ source: string; resourceScope: string }> }>;
    }).items.find((agent) => agent.id === agentId);
    assert.ok(listAgent);
    assert.ok(listAgent.semanticCapabilityIds.includes('infrastructure.diagnostics.read'));
    assert.equal(listAgent.capabilities?.some((capability) => capability.source === 'target'), false);

    const fetched = await callController(getAgent, createRequest(
      { agentId },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.equal('workflowsUsingAgent' in (fetched.body as { agent: object }).agent, false);
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

  it('creates and updates custom agents for managers', async () => {
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
        avatarEmoji: '🚀',
        description: 'Coordinates release checks.',
        instructions: 'Prepare release notes and ask before write tools.',
        providerType: 'internal',
        approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true }
      }
    ));

    assert.equal(created.statusCode, 201);
    const agent = (created.body as { agent: { id: string; avatarEmoji: string; status: string; providerType: string; trustPolicy: { level: string; allowExternalData: boolean } } }).agent;
    assert.equal(agent.avatarEmoji, '🚀');
    assert.equal(agent.status, 'active');
    assert.equal(agent.providerType, 'internal');
    assert.deepEqual(agent.trustPolicy, { level: 'restricted', allowExternalData: false });

    const patched = await callController(updateAgent, createRequest(
      { agentId: agent.id },
      {
        workspaceId: 'workspace-1',
        instructions: 'Prepare release notes and draft a PR plan.',
        avatarEmoji: '🧭'
      }
    ));
    assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
    assert.equal((patched.body as { agent: { avatarEmoji: string } }).agent.avatarEmoji, '🧭');

    assert.deepEqual(auditEvents, [
      'agent.definition_created.v1',
      'agent.definition_updated.v1'
    ]);

    const fetched = await callController(getAgent, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.body as { agent: { id: string; providerType: string } }).agent.id, agent.id);
    assert.equal((fetched.body as { agent: { providerType: string } }).agent.providerType, 'internal');
    assert.equal((fetched.body as { agent: { avatarEmoji: string } }).agent.avatarEmoji, '🧭');
  });

  it('rejects Agent avatar values that are not exactly one emoji grapheme', async () => {
    installWorkspace('admin');

    const response = await callController(createAgent, createRequest(
      { workspaceId: 'workspace-1' },
      { name: 'Invalid avatar', avatarEmoji: 'AB', instructions: 'Inspect assigned work.' }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'AGENT_AVATAR_EMOJI_INVALID');
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
        skills: ['missing-skill']
      }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'AGENT_CAPABILITY_ROUTE_REQUIRED');
  });
});
