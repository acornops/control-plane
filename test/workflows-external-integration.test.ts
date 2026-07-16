import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import {
  createSession,
  getWorkflow,
  listWorkflows,
  postMessage
} from '../src/controllers/workflows-controller.js';
import { repo } from '../src/store/repository.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import {
  resetWorkflowRepositoryForTests,
  updateWorkflowDefinitionScope
} from '../src/store/repository-workflows.js';
import {
  callController,
  createExternalIntegrationRequest,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
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
  resetWorkflowRepositoryForTests();
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflow external integration access', () => {
  it('lets external integrations list and run active read-only workflows only', async () => {
    installWorkspace('operator');
    const listResponse = await callController(listWorkflows, createExternalIntegrationRequest({ workspaceId: 'workspace-1' }));

    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual((listResponse.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ['cluster-triage']);

    const detailReq = createExternalIntegrationRequest({ workflowId: 'cluster-triage' });
    detailReq.query = { workspaceId: 'workspace-1' };
    const detailResponse = await callController(getWorkflow, detailReq);
    assert.equal(detailResponse.statusCode, 200);
    assert.equal((detailResponse.body as { workflow: { id: string } }).workflow.id, 'cluster-triage');

    const auditEvents: Array<{ actorType?: string; actorTokenId?: string | null; eventType: string }> = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      auditEvents.push({
        actorType: event.actorType,
        actorTokenId: event.actorTokenId,
        eventType: event.eventType
      });
      return null;
    };

    const executionDispatches: unknown[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      if (url === 'http://localhost:8080/api/v1/runs' && init?.method === 'POST') {
        executionDispatches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return new Response(`unexpected request: ${url}`, { status: 500 });
    });

    const sessionResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    assert.equal(sessionResponse.statusCode, 201);
    const sessionId = (sessionResponse.body as { session: { id: string } }).session.id;

    const messageResponse = await callController(postMessage, createExternalIntegrationRequest(
      { sessionId },
      {
        content: 'Triage @cluster[cluster].',
        inputs: { targetId: 'cluster-1' },
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }
    ));
    assert.equal(messageResponse.statusCode, 202);
    const runBody = messageResponse.body as { run_id: string; workflow_run_id: string };
    assert.ok(runBody.run_id);
    assert.ok(runBody.workflow_run_id);

    const mutableConfig = config as typeof config & { AUTOMATION_RUNTIME_MODE: 'off' | 'shadow' | 'canary' | 'on' };
    const originalRuntimeMode = config.AUTOMATION_RUNTIME_MODE;
    mutableConfig.AUTOMATION_RUNTIME_MODE = 'on';
    try {
      assert.equal(await runAutomationOutboxTick(), 1);
    } finally {
      mutableConfig.AUTOMATION_RUNTIME_MODE = originalRuntimeMode;
    }
    assert.equal(executionDispatches.length, 1);
    assert.deepEqual(auditEvents, [
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.session_created.v1' },
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.run_created.v1' }
    ]);
  });

  it('blocks external integrations from unavailable workflow categories', async () => {
    installWorkspace('operator');

    const readWriteResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'repository-operation' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata'] }
    ));
    assert.equal(readWriteResponse.statusCode, 403);
    assert.match((readWriteResponse.body as { error: { message: string } }).error.message, /active/);

    const approvalGatedResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['selected_chat_sessions'] }
    ));
    assert.equal(approvalGatedResponse.statusCode, 403);
    assert.match((approvalGatedResponse.body as { error: { message: string } }).error.message, /approval gates/);

    await updateWorkflowDefinitionScope('workspace-1', 'cluster-triage', { status: 'paused' });
    const pausedResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory'] }
    ));
    assert.equal(pausedResponse.statusCode, 403);
    assert.equal((pausedResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_NOT_ACTIVE');

    const listResponse = await callController(listWorkflows, createExternalIntegrationRequest({ workspaceId: 'workspace-1' }));
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual((listResponse.body as { items: Array<{ id: string }> }).items, []);
  });

  it('requires create_sessions and exact context grants before external workflow sessions are created', async () => {
    installWorkspace('operator');

    repo.getExternalIntegrationWorkspaceGrant = async () => ({
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_read_only_runs'],
      grantedByUserId: 'user-1',
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z'
    });
    const missingCapabilityResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory'] }
    ));
    assert.equal(missingCapabilityResponse.statusCode, 403);
    assert.equal((missingCapabilityResponse.body as { error: { code: string } }).error.code, 'FORBIDDEN');

    installWorkspace('operator');
    const missingGrantResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata'] }
    ));
    assert.equal(missingGrantResponse.statusCode, 403);
    assert.equal((missingGrantResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_CONTEXT_GRANT_DENIED');

    const extraGrantResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory', 'audit_events'] }
    ));
    assert.equal(extraGrantResponse.statusCode, 400);
    assert.equal((extraGrantResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_CONTEXT_GRANT_UNKNOWN');
  });
});
