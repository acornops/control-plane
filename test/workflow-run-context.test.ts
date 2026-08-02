import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { getWorkflowRunContext } from '../src/controllers/internal-execution-controller.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { listAgentDefinitions } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition
} from '../src/store/repository-workflows.js';
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

describe('Workflow run context', () => {
  it('returns the Workflow prompt', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'incident-report-pdf');
    assert.ok(workflow);
    const agents = await listAgentDefinitions(workflow.workspaceId);
    const specialist = agents.find((agent) => agent.id === workflow.agentIds[0]);
    assert.ok(specialist);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: await listCapabilityRoutingMappings(workflow.workspaceId, { activeReviewedOnly: true }),
      actor: {
        userId: 'user-1',
        role: 'operator',
        permissions: getWorkspacePermissions('operator')
      }
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      compiledAccessScope,
      content: 'Summarize the pinned incident.',
      specialistSnapshot: specialist
    });
    const response = await callController(getWorkflowRunContext, createRequest({ runId: created.run.id }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as {
      messages: Array<{ role: string; content: string }>;
    }).messages, [{ role: 'user', content: 'Summarize the pinned incident.' }]);
  });
});
