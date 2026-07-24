import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { getWorkflowRunContext } from '../src/controllers/internal-execution-controller.js';
import { promptResourceRegistry } from '../src/services/prompt-resources/index.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { listAgentDefinitions } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition
} from '../src/store/repository-workflows.js';
import type { PromptResourceBinding } from '../src/types/prompt-resources.js';
import {
  callController,
  createRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(restoreControllerRegressionState);
after(closeAutomationDatabaseFixtures);

describe('generic Workflow run context', () => {
  it('loads pinned inline resources without consulting mutable Workflow definitions', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'incident-report-pdf');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const specialist = agents.find((agent) => agent.id === workflow.agentIds[0]);
    assert.ok(specialist);
    const binding: PromptResourceBinding = {
      bindingId: 'binding-chat-1',
      type: 'chat',
      resourceId: 'chat-1',
      provider: 'test.chat',
      providerVersion: '1',
      workspaceId: workflow.workspaceId,
      labelSnapshot: 'Pinned incident chat',
      source: 'explicit',
      operations: ['read'],
      contextMode: 'inline'
    };
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      },
      approvedContextGrants: [],
      resourceBindings: [binding],
      bindingDigest: digestBindings([binding])
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      compiledAccessScope,
      content: 'Summarize the pinned incident.',
      promptDigest: digestPrompt('Summarize the pinned incident.'),
      bindingDigest: digestBindings([binding]),
      resourceBindings: [binding],
      resolvedAt: '2026-07-24T00:00:00.000Z',
      specialistSnapshot: specialist
    });
    mock.method(promptResourceRegistry, 'provider', () => ({
      descriptor: () => ({ provider: 'test.chat' }),
      loadContext: async () => ({
        messages: [{ role: 'user', content: 'Pinned incident evidence.' }]
      })
    }) as never);

    const response = await callController(getWorkflowRunContext, createRequest({ runId: created.run.id }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as {
      messages: Array<{ role: string; content: string }>;
    }).messages, [
      { role: 'user', content: 'Pinned incident evidence.' },
      { role: 'user', content: 'Summarize the pinned incident.' }
    ]);
    assert.deepEqual((response.body as { resources: Array<{ bindingId: string }> }).resources
      .map((resource) => resource.bindingId), ['binding-chat-1']);
  });
});
