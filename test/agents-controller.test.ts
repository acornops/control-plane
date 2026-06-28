import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createAgent,
  createAgentTrigger,
  createAgentVersion,
  deleteAgentTrigger,
  getAgent,
  listAgentActivity,
  listAgents,
  testAgent,
  updateAgent,
  updateAgentTrigger
} from '../src/controllers/agents-controller.js';
import { resetAgentRepositoryForTests } from '../src/store/repository-agents.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(() => {
  resetAgentRepositoryForTests();
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

    const fetched = await callController(getAgent, createRequest(
      { agentId: agent.id },
      { workspaceId: 'workspace-1' }
    ));
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.body as { agent: { id: string; providerType: string } }).agent.id, agent.id);
    assert.equal((fetched.body as { agent: { providerType: string } }).agent.providerType, 'external');
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
