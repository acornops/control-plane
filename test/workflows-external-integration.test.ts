import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { config } from '../src/config.js';
import {
  createSession,
  getWorkflow,
  listWorkflows,
  postMessage
} from '../src/controllers/workflows-controller.js';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { getWorkflowExecution } from '../src/controllers/workflow-executions-controller.js';
import { getWorkflowReportMetadata } from '../src/controllers/workflow-reports-controller.js';
import { repo } from '../src/store/repository.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import {
  resetWorkflowRepositoryForTests,
  appendWorkflowRunEvents,
  getWorkflowRun,
  listWorkflowRunApprovals,
  updateWorkflowDefinitionScope
} from '../src/store/repository-workflows.js';
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
import { listWorkflowExecutionEvents } from '../src/store/repository-workflow-execution-events.js';
import { recordWorkflowRunEvents } from '../src/services/workflow-execution-events.js';
import { createWorkflowReport } from '../src/store/repository-workflow-reports.js';
import { createAutomationRunApproval } from '../src/store/repository-automation-approvals.js';
import { installExternalWriteGrant, withWriteCapability } from './helpers/external-workflow-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});

afterEach(() => {
  resetWorkflowRepositoryForTests();
  restoreControllerRegressionState();
});

after(closeAutomationDatabaseFixtures);

describe('workflow external integration access', () => {
  it('lets external integrations list and run active workflows allowed by their effective grant', async () => {
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
      if (isMcpReadinessRequest(input, init)) return createReadyMcpReadinessResponse();
      if (url.includes('/api/v1/internal/mcp/tools?') && url.includes('target_id=cluster-1')) {
        return new Response(JSON.stringify(['get_resource', 'get_resource_logs', 'list_resources'].map((name) => ({
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
        }))), { status: 200 });
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
      { content: 'Triage @target[Test Cluster].' }
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
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.session_created.v2' },
      { actorType: 'external_integration', actorTokenId: 'external-chat', eventType: 'workflow.run_created.v2' }
    ]);
  });

  it('requires write capability for gated workflows and still rejects inactive workflows', async () => {
    installWorkspace('admin');

    await updateWorkflowDefinitionScope('workspace-1', 'cluster-triage', {
      capabilityPolicy: { mode: 'read_write' }
    });
    const readWriteResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory'] }
    ));
    assert.equal(readWriteResponse.statusCode, 403);
    assert.match((readWriteResponse.body as { error: { message: string } }).error.message, /read-only/);

    const approvalGatedResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: [] }
    ));
    assert.equal(approvalGatedResponse.statusCode, 403);
    assert.match((approvalGatedResponse.body as { error: { message: string } }).error.message, /does not permit/);

    installExternalWriteGrant();
    const writeEnabledRequest = withWriteCapability(createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['selected_chat_sessions'] }
    ));
    const writeEnabledResponse = await callController(createSession, writeEnabledRequest);
    assert.equal(writeEnabledResponse.statusCode, 201);

    await updateWorkflowDefinitionScope('workspace-1', 'cluster-triage', { status: 'paused' });
    const pausedResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory'] }
    ));
    assert.equal(pausedResponse.statusCode, 403);
    assert.equal((pausedResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION');

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
    assert.equal((missingCapabilityResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_NOT_AVAILABLE_FOR_EXTERNAL_INTEGRATION');

    installWorkspace('operator');
    const missingGrantResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata'] }
    ));
    assert.equal(missingGrantResponse.statusCode, 409);
    assert.equal((missingGrantResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_CONTEXT_GRANT_DENIED');

    const extraGrantResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['workspace_metadata', 'target_inventory', 'audit_events'] }
    ));
    assert.equal(extraGrantResponse.statusCode, 400);
    assert.equal((extraGrantResponse.body as { error: { code: string } }).error.code, 'WORKFLOW_CONTEXT_GRANT_UNKNOWN');
  });

  it('requires a new request id and exact integration-link ownership for session replies', async () => {
    installWorkspace('operator');
    const sessionResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'cluster-triage' },
      {
        workspaceId: 'workspace-1',
        approvedContextGrants: ['workspace_metadata', 'target_inventory']
      }
    ));
    assert.equal(sessionResponse.statusCode, 201);
    const sessionId = (sessionResponse.body as { session: { id: string } }).session.id;

    const missingRequestId = await callController(postMessage, createExternalIntegrationRequest(
      { sessionId },
      {
        content: 'Triage @cluster[cluster].',
        inputs: { targetId: 'cluster-1' },
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }
    ));
    assert.equal(missingRequestId.statusCode, 400);
    assert.equal(
      (missingRequestId.body as { error: { code: string } }).error.code,
      'WORKFLOW_CLIENT_REQUEST_ID_REQUIRED'
    );

    const otherLinkRequest = createExternalIntegrationRequest(
      { sessionId },
      {
        content: 'Triage @cluster[cluster].',
        clientRequestId: 'external-message-other-link',
        inputs: { targetId: 'cluster-1' },
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }
    );
    otherLinkRequest.auth.credential.linkId = 'link-2';
    const otherLinkResponse = await callController(postMessage, otherLinkRequest);
    assert.equal(otherLinkResponse.statusCode, 403);
    assert.equal(
      (otherLinkResponse.body as { error: { code: string } }).error.code,
      'EXTERNAL_INTEGRATION_WORKFLOW_SESSION_NOT_OWNED'
    );
  });

  it('creates fresh gated executions on replies and permits only exact-origin decisions', async () => {
    installWorkspace('admin');
    installExternalWriteGrant();
    const incidentChat = createSessionRecord({ id: 'incident-chat-1', title: 'Payments incident' });
    repo.getSession = async (sessionId) => sessionId === incidentChat.id ? incidentChat : null;
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });

    const sessionResponse = await callController(createSession, withWriteCapability(createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: ['selected_chat_sessions'] }
    )));
    assert.equal(sessionResponse.statusCode, 201);
    const sessionId = (sessionResponse.body as { session: { id: string } }).session.id;

    const launch = async (clientRequestId: string) => callController(postMessage, withWriteCapability(createExternalIntegrationRequest(
      { sessionId },
      {
        content: 'Generate the incident report from @chat[Payments incident].',
        clientRequestId,
        inputs: { chatSessionIds: [incidentChat.id] }
      }
    )));
    const first = await launch('external-gated-message-1');
    const firstRetry = await launch('external-gated-message-1');
    await updateWorkflowDefinitionScope('workspace-1', 'incident-report-pdf', {
      starterPrompt: 'Updated prompt for future sessions only.'
    });
    const second = await launch('external-gated-message-2');
    assert.equal(first.statusCode, 202);
    assert.equal(firstRetry.statusCode, 202);
    assert.equal(second.statusCode, 202);
    const firstBody = first.body as { executionId: string; run_id: string };
    const firstRetryBody = firstRetry.body as { executionId: string; run_id: string };
    const secondBody = second.body as { executionId: string; run_id: string };
    assert.deepEqual(firstRetryBody, firstBody);
    assert.notEqual(firstBody.executionId, secondBody.executionId);
    const secondExecutionResponse = await callController(
      getWorkflowExecution,
      createExternalIntegrationRequest({ executionId: secondBody.executionId })
    );
    assert.equal(secondExecutionResponse.statusCode, 200);
    assert.equal(
      (secondExecutionResponse.body as { execution: { workflowVersion: number } }).execution.workflowVersion,
      3
    );
    const firstRun = await getWorkflowRun(firstBody.run_id);
    assert.ok(firstRun);
    const acceptedRunEvents = await appendWorkflowRunEvents(firstRun.id, [{
      schema_version: 1,
      run_id: firstRun.id,
      seq: 1,
      ts: '2026-07-17T00:00:00.000Z',
      type: 'run_started',
      payload: {}
    }]);
    await recordWorkflowRunEvents({
      executionId: firstBody.executionId,
      workspaceId: 'workspace-1',
      runId: firstRun.id,
      stepIndex: firstRun.stepIndex,
      events: acceptedRunEvents
    });
    await recordWorkflowRunEvents({
      executionId: firstBody.executionId,
      workspaceId: 'workspace-1',
      runId: firstRun.id,
      stepIndex: firstRun.stepIndex,
      events: acceptedRunEvents
    });
    const executionEvents = await listWorkflowExecutionEvents(firstBody.executionId);
    assert.deepEqual(
      executionEvents.map((event) => event.type),
      ['execution_created', 'run_created', 'approval_requested', 'run_event']
    );
    assert.equal(
      (executionEvents.at(-1)?.payload.runEvent as { type: string }).type,
      'run_started'
    );
    const firstApproval = (await listWorkflowRunApprovals(firstBody.run_id))[0];
    const secondApproval = (await listWorkflowRunApprovals(secondBody.run_id))[0];
    assert.ok(firstApproval);
    assert.ok(secondApproval);
    assert.notEqual(firstApproval.id, secondApproval.id);

    const otherLinkDecision = withWriteCapability(createExternalIntegrationRequest(
      { runId: firstBody.run_id, approvalId: firstApproval.id },
      { decision: 'approved' }
    ));
    otherLinkDecision.auth.credential.linkId = 'link-2';
    const denied = await callController(decideRunApproval, otherLinkDecision);
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (denied.body as { error: { code: string } }).error.code,
      'EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED'
    );

    const workspaceVisible = createExternalIntegrationRequest({ executionId: firstBody.executionId });
    workspaceVisible.auth.credential.linkId = 'link-2';
    const visibleExecution = await callController(getWorkflowExecution, workspaceVisible);
    assert.equal(visibleExecution.statusCode, 200);
    const serializedExecution = JSON.stringify(visibleExecution.body);
    for (const privateField of [
      'inputContext',
      'workflowSnapshot',
      'compiledAccessScope',
      'continuation',
      'requestProvenance',
      'externalIntegrationLinkId',
      'externalIntegrationClientId'
    ]) {
      assert.equal(serializedExecution.includes(privateField), false);
    }

    const report = await createWorkflowReport({
      workspaceId: 'workspace-1',
      executionId: firstBody.executionId,
      runId: firstBody.run_id,
      title: 'Payments incident',
      source: { markdown: '# Private report source' },
      provenance: { internal: 'private provenance' },
      retentionDays: 30
    });
    const ownedReport = await callController(getWorkflowReportMetadata, createExternalIntegrationRequest({
      reportId: report.id
    }));
    assert.equal(ownedReport.statusCode, 200);
    assert.equal(JSON.stringify(ownedReport.body).includes('Private report source'), false);
    assert.equal(JSON.stringify(ownedReport.body).includes('private provenance'), false);
    const otherLinkReportRequest = createExternalIntegrationRequest({ reportId: report.id });
    otherLinkReportRequest.auth.credential.linkId = 'link-2';
    const hiddenReport = await callController(getWorkflowReportMetadata, otherLinkReportRequest);
    assert.equal(hiddenReport.statusCode, 404);

    const approved = await callController(decideRunApproval, withWriteCapability(createExternalIntegrationRequest(
      { runId: firstBody.run_id, approvalId: firstApproval.id },
      { decision: 'approved' }
    )));
    assert.equal(approved.statusCode, 200);
    assert.equal((approved.body as { status: string }).status, 'approved');

    const runtimeApproval = await createAutomationRunApproval({
      workspaceId: 'workspace-1',
      sourceType: 'workflow',
      sourceId: firstBody.executionId,
      runId: firstBody.run_id,
      approvalKind: 'tool_write',
      toolCallId: 'external-runtime-write-1',
      toolName: 'reports.publish',
      summary: 'Publish the approved report.',
      requestedBy: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      continuationState: { cursor: 'before-publish' }
    });
    const runtimeApproved = await callController(
      decideRunApproval,
      withWriteCapability(createExternalIntegrationRequest(
        { runId: firstBody.run_id, approvalId: runtimeApproval.id },
        { decision: 'approved' }
      ))
    );
    assert.equal(runtimeApproved.statusCode, 200);
    assert.equal((runtimeApproved.body as { status: string }).status, 'approved');

    repo.getExternalIntegrationWorkspaceGrant = async () => ({
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_sessions', 'create_read_only_runs'],
      grantedByUserId: 'user-1',
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T01:00:00.000Z'
    });
    const rejectedAfterWriteRevocation = await callController(
      decideRunApproval,
      withWriteCapability(createExternalIntegrationRequest(
        { runId: secondBody.run_id, approvalId: secondApproval.id },
        { decision: 'rejected' }
      ))
    );
    assert.equal(rejectedAfterWriteRevocation.statusCode, 200);
    assert.equal((rejectedAfterWriteRevocation.body as { status: string }).status, 'rejected');
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
});
