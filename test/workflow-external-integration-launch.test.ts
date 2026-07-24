import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import {
  createSession,
  getWorkflow,
  listWorkflows,
  postMessage
} from '../src/controllers/workflows-controller.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createExternalIntegrationRequest,
  createReadyMcpReadinessResponse,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isMcpReadinessRequest,
  isWorkspaceAiCredentialStatusRequest,
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

describe('external integration Workflow launch', () => {
  it('lists, resolves, and dispatches an allowed Workflow', async () => {
    installWorkspace('operator');
    const listResponse = await callController(
      listWorkflows,
      createExternalIntegrationRequest({ workspaceId: 'workspace-1' })
    );
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual((listResponse.body as {
      items: Array<{ id: string }>;
    }).items.map((item) => item.id), ['cluster-triage']);

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
      if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
      if (url.includes('/api/v1/internal/mcp/tools?') && url.includes('target_id=cluster-1')) {
        return new Response(JSON.stringify(
          ['get_resource', 'get_resource_logs', 'list_resources'].map((name) => ({
            name,
            server_id: 'acornops-target-agent',
            model_alias: name,
            mcp_server_url: 'builtin://agentk',
            timeout_ms: 10_000,
            description: `${name} fixture`,
            capability: 'read',
            source: 'builtin',
            input_schema: {},
            enabled: true
          }))
        ), { status: 200 });
      }
      if (url === `${config.EXECUTION_ENGINE_BASE_URL}/api/v1/runs` && init?.method === 'POST') {
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
      { content: 'Triage @target[Test Cluster].', clientRequestId: 'external-triage-message-1' }
    ));
    assert.equal(messageResponse.statusCode, 202);
    const runBody = messageResponse.body as { run_id: string; executionId: string };
    assert.ok(runBody.run_id);
    assert.ok(runBody.executionId);

    const mutableConfig = config as typeof config & {
      AUTOMATION_RUNTIME_MODE: 'off' | 'shadow' | 'canary' | 'on';
    };
    const originalRuntimeMode = config.AUTOMATION_RUNTIME_MODE;
    mutableConfig.AUTOMATION_RUNTIME_MODE = 'on';
    try {
      assert.equal(await runAutomationOutboxTick(), 1);
    } finally {
      mutableConfig.AUTOMATION_RUNTIME_MODE = originalRuntimeMode;
    }
    assert.equal(executionDispatches.length, 1);
    assert.deepEqual(auditEvents, [
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.session_created.v2' },
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.run_created.v2' }
    ]);
  });
});
