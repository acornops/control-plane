import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createAgent, listAgents } from '../src/controllers/agents-controller.js';
import { requirePublicAgentRoute } from '../src/controllers/public-agent-visibility.js';
import { provisionStarterAutomation } from '../src/services/automation-templates.js';
import { installAutomationTemplate } from '../src/services/automation-template-lifecycle.js';
import { listTemplateInstallations } from '../src/store/repository-automation-templates.js';
import { getWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
});

afterEach(() => {
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('public Agent visibility', () => {
  it('rejects public Manager creation and delegation configuration', async () => {
    installWorkspace('admin');
    for (const body of [
      { name: 'Manager', instructions: 'Coordinate work.', kind: 'manager' },
      { name: 'Delegator', instructions: 'Coordinate work.', delegateAgentIds: ['agent-1'] }
    ]) {
      const response = await callController(createAgent, createRequest(
        { workspaceId: 'workspace-1' },
        body
      ));
      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, 'MANAGER_SYSTEM_OWNED');
    }
  });

  it('omits the system coordinator and returns not found for its public route identity', async () => {
    installWorkspace('viewer');
    await provisionStarterAutomation({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    await installAutomationTemplate({ workspaceId: 'workspace-1', templateId: 'incident-investigation', installedBy: 'user-1' });
    const [installation] = await listTemplateInstallations('workspace-1');
    const coordinatedWorkflowId = installation.recordIds['workflow:managedResponse'];
    const coordinatedWorkflow = await getWorkflowDefinition('workspace-1', coordinatedWorkflowId);
    assert.ok(coordinatedWorkflow);
    const coordinatorId = coordinatedWorkflow.entryAgentId;

    const listed = await callController(listAgents, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listed.statusCode, 200);
    const items = (listed.body as { items: Array<{ id: string; kind: string }> }).items;
    assert.equal(items.length, 2);
    assert.equal(items.some((agent) => agent.id === coordinatorId || agent.kind === 'manager'), false);

    const direct = await callController(
      requirePublicAgentRoute,
      createRequest({ workspaceId: 'workspace-1', agentId: coordinatorId })
    );
    assert.equal(direct.statusCode, 404);
    assert.equal((direct.body as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});
