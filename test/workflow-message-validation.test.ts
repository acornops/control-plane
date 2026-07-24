import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createSession, postMessage } from '../src/controllers/workflows-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
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

test('workflow messages reject malformed optional client request IDs before dispatch', async () => {
  installWorkspace('operator');
  const createdSession = await callController(createSession, createRequest(
    { workflowId: 'cluster-triage' },
    {
      workspaceId: 'workspace-1',
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    }
  ));
  assert.equal(createdSession.statusCode, 201);
  const sessionId = (createdSession.body as { session: { id: string } }).session.id;

  for (const clientRequestId of [123, '   ']) {
    const response = await callController(postMessage, createRequest(
      { sessionId },
      {
        kind: 'launch',
        inputs: { target: 'cluster-1' },
        clientRequestId
      }
    ));
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'WORKFLOW_CLIENT_REQUEST_ID_INVALID'
    );
  }
});
