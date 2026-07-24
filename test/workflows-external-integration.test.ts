import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createSession, listWorkflows, postMessage } from '../src/controllers/workflows-controller.js';
import { decideRunApproval } from '../src/controllers/runs-controller.js';
import { getWorkflowExecution } from '../src/controllers/workflow-executions-controller.js';
import { getWorkflowReportMetadata } from '../src/controllers/workflow-reports-controller.js';
import { repo } from '../src/store/repository.js';
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
  createRequest,
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
import {
  assertExternalApprovalListSanitized,
  installExternalWriteGrant,
  withWriteCapability
} from './helpers/external-workflow-fixtures.js';
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
    assert.match((readWriteResponse.body as { error: { message: string } }).error.message, /does not permit/);

    const approvalGatedResponse = await callController(createSession, createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: [] }
    ));
    assert.equal(approvalGatedResponse.statusCode, 403);
    assert.match((approvalGatedResponse.body as { error: { message: string } }).error.message, /does not permit/);

    installExternalWriteGrant();
    const writeEnabledRequest = withWriteCapability(createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: [] }
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
        kind: 'launch',
        inputs: { target: 'cluster-1' }
      }
    ));
    assert.equal(missingRequestId.statusCode, 400);
    assert.equal(
      (missingRequestId.body as { error: { code: string } }).error.code,
      'WORKFLOW_CLIENT_REQUEST_ID_REQUIRED'
    );

    const invalidRequestId = await callController(postMessage, createExternalIntegrationRequest(
      { sessionId },
      {
        kind: 'launch',
        inputs: { target: 'cluster-1' },
        clientRequestId: 123
      }
    ));
    assert.equal(invalidRequestId.statusCode, 400);
    assert.equal(
      (invalidRequestId.body as { error: { code: string } }).error.code,
      'WORKFLOW_CLIENT_REQUEST_ID_INVALID'
    );

    const otherLinkRequest = createExternalIntegrationRequest(
      { sessionId },
      {
        kind: 'launch',
        inputs: { target: 'cluster-1' },
        clientRequestId: 'external-message-other-link',
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
    const incidentChat = await repo.addSession('workspace-1', 'cluster-1', 'user-1', 'Payments incident');
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse('workspace-1')), { status: 200 });
      }
      return new Response(`unexpected request: ${String(input)}`, { status: 500 });
    });

    const sessionResponse = await callController(createSession, withWriteCapability(createExternalIntegrationRequest(
      { workflowId: 'incident-report-pdf' },
      { workspaceId: 'workspace-1', approvedContextGrants: [] }
    )));
    assert.equal(sessionResponse.statusCode, 201);
    const sessionId = (sessionResponse.body as { session: { id: string } }).session.id;

    const launch = async (clientRequestId: string) => callController(postMessage, withWriteCapability(createExternalIntegrationRequest(
      { sessionId },
      {
        kind: 'launch',
        inputs: {
          report_title: 'Payments incident',
          incident_context: incidentChat.id
        },
        clientRequestId
      }
    )));
    const followUp = async (clientRequestId: string) => callController(postMessage, withWriteCapability(createExternalIntegrationRequest(
      { sessionId },
      {
        kind: 'follow_up',
        content: 'Include the previous hour as well.',
        clientRequestId
      }
    )));
    const [first, firstRetry] = await Promise.all([
      launch('external-gated-message-1'),
      launch('external-gated-message-1')
    ]);
    const changedRetry = await callController(postMessage, withWriteCapability(createExternalIntegrationRequest(
      { sessionId },
      {
        kind: 'launch',
        inputs: {
          report_title: 'A different report',
          incident_context: incidentChat.id
        },
        clientRequestId: 'external-gated-message-1'
      }
    )));
    await updateWorkflowDefinitionScope('workspace-1', 'incident-report-pdf', {
      prompt: 'Updated prompt for future sessions only.'
    });
    const secondLaunch = await launch('external-gated-message-2');
    const second = await followUp('external-gated-message-3');
    assert.equal(first.statusCode, 202);
    assert.equal(firstRetry.statusCode, 202);
    assert.equal(changedRetry.statusCode, 409);
    assert.equal(
      (changedRetry.body as { error: { code: string } }).error.code,
      'WORKFLOW_CLIENT_REQUEST_ID_CONFLICT'
    );
    assert.equal(secondLaunch.statusCode, 409);
    assert.equal(
      (secondLaunch.body as { error: { code: string } }).error.code,
      'WORKFLOW_SESSION_ALREADY_LAUNCHED'
    );
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
    assert.deepEqual(firstRun.resourceBindings.map((binding) => binding.type), ['chat']);
    const followUpRun = await getWorkflowRun(secondBody.run_id);
    assert.ok(followUpRun);
    assert.deepEqual(
      followUpRun.resourceBindings.map((binding) => binding.type).sort(),
      ['chat', 'workflow_session']
    );
    assert.equal(
      followUpRun.resourceBindings.filter((binding) => binding.type === 'workflow_session').length,
      1
    );
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
      events: acceptedRunEvents
    });
    await recordWorkflowRunEvents({
      executionId: firstBody.executionId,
      workspaceId: 'workspace-1',
      runId: firstRun.id,
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
    const browserExecution = await callController(getWorkflowExecution, createRequest({ executionId: firstBody.executionId }));
    const browserBody = browserExecution.body as {
      execution: { workflowSnapshot: unknown };
      attempts: Array<{ executorRole: string; parentRunId: string | null }>;
    };
    assert.ok(browserBody.execution.workflowSnapshot);
    assert.equal(browserBody.attempts[0].executorRole, 'specialist');
    assert.equal(browserBody.attempts[0].parentRunId, null);
    const serializedBrowserExecution = JSON.stringify(browserBody);
    for (const privateField of [
      'prompt_text',
      'promptText',
      'compiled_access_scope',
      'compiledAccessScope',
      'resource_bindings',
      'resourceBindings',
      'executor_snapshot',
      'executorSnapshot'
    ]) {
      assert.equal(serializedBrowserExecution.includes(privateField), false);
    }

    const report = await createWorkflowReport({
      workspaceId: 'workspace-1',
      executionId: firstBody.executionId,
      runId: firstBody.run_id,
      title: 'Payments incident',
      source: { markdown: '# Private report source' },
      provenance: { internal: 'private provenance' },
      retentionDays: 30,
      toolCallId: 'external-report-1'
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
      toolName: 'reports.pdf.generate',
      toolRef: { serverId: 'acornops-workspace-native', toolName: 'reports.pdf.generate' },
      summary: 'Publish the approved report.',
      arguments: { reportSource: 'private report source' },
      requestedBy: 'user-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      continuationState: { cursor: 'before-publish' }
    });
    await assertExternalApprovalListSanitized(firstBody.run_id);
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
