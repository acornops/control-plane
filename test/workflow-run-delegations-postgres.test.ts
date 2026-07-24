import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { commitRun } from '../src/controllers/internal-execution-controller.js';
import { cancelRun } from '../src/controllers/runs-controller.js';
import { cancelWorkflowExecution } from '../src/controllers/workflow-executions-controller.js';
import { db } from '../src/infra/db.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling
} from '../src/services/workflow-access.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import { runAutomationOutboxTick } from '../src/services/automation-outbox-worker.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import {
  createAutomationRunApproval,
  getAutomationRunApproval,
  getAutomationRunContinuation,
  recomputeWorkflowExecutionStatusForRun
} from '../src/store/repository-automation-approvals.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  createDelegatedWorkflowRun,
  WorkflowDelegationConflictError
} from '../src/store/repository-workflow-run-delegations.js';
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  createWorkflowSession,
  listWorkflowChildRuns,
  updateWorkflowRun
} from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
afterEach(() => {
  mock.restoreAll();
  restoreControllerRegressionState();
});
after(closeAutomationDatabaseFixtures);

async function coordinatedRoot() {
  const agents = (await Promise.all([
    getAgentDefinition('workspace-1', 'agent-cluster-triage'),
    getAgentDefinition('workspace-1', 'agent-incident-reporter')
  ])).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  assert.equal(agents.length, 2);
  const workflow = await createWorkflowDefinition({
    workspaceId: 'workspace-1',
    name: 'Coordinated delegation probe',
    prompt: 'Inspect the selected target.',
    agentIds: agents.map((agent) => agent.id),
    resourceRequirements: [],
    capabilityPolicy: {
      mode: 'read_only',
      restrictionMode: 'restrict',
      semanticCapabilityIds: ['target.diagnostics.read'],
      contextGrants: ['workspace_metadata', 'target_inventory'],
      maxRuntimeSeconds: 300,
      retentionDays: 30,
      approvalRequirements: []
    },
    requiredPermissions: ['read_workspace_data'],
    createdBy: actor.userId,
    status: 'active'
  });
  const mappings = await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true });
  const ceiling = compileWorkflowSessionCeiling({
    workflow,
    selectedAgents: agents,
    mappings,
    actor,
    approvedContextGrants: ['workspace_metadata', 'target_inventory']
  });
  const rootScope = compileWorkflowAccessScope({
    workflow,
    selectedAgents: agents,
    mappings,
    actor,
    approvedContextGrants: ['workspace_metadata', 'target_inventory'],
    targetRoute: { id: 'cluster-1', targetType: 'kubernetes' }
  });
  const session = await createWorkflowSession({
    workflow,
    createdBy: actor.userId,
    compiledAccessScope: ceiling
  });
  const created = await createWorkflowExecution({
    workflow,
    session,
    compiledAccessScope: rootScope,
    content: 'Inspect the selected target.',
    promptDigest: digestPrompt('Inspect the selected target.'),
    bindingDigest: digestBindings([]),
    resourceBindings: [],
    resolvedAt: new Date().toISOString(),
    targetId: 'cluster-1',
    targetType: 'kubernetes'
  });
  const parent = await updateWorkflowRun(created.run.id, { status: 'running' });
  assert.ok(parent);
  await db.query("UPDATE workflow_executions SET status='running' WHERE id=$1", [created.execution.id]);
  await db.query(
    "UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1",
    [parent.id]
  );
  const specialist = agents.find((agent) => agent.id === 'agent-cluster-triage');
  assert.ok(specialist);
  const childWorkflow = {
    ...workflow,
    capabilityPolicy: {
      ...workflow.capabilityPolicy,
      restrictionMode: 'restrict' as const,
      semanticCapabilityIds: ['target.diagnostics.read']
    }
  };
  const childScope = compileWorkflowAccessScope({
    workflow: childWorkflow,
    selectedAgents: agents,
    specialistAgent: specialist,
    delegatedSpecialist: true,
    mappings: mappings.filter((mapping) => mapping.agentId === specialist.id),
    actor,
    approvedContextGrants: ['workspace_metadata', 'target_inventory'],
    targetRoute: { id: 'cluster-1', targetType: 'kubernetes' }
  });
  return { parent, specialist, childScope };
}

function delegationInput(
  setup: Awaited<ReturnType<typeof coordinatedRoot>>,
  toolCallId: string
) {
  return {
    parent: setup.parent,
    specialist: setup.specialist,
    compiledAccessScope: setup.childScope,
    toolCallId,
    capabilityId: 'target.diagnostics.read',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    taskPrompt: `Inspect the target for ${toolCallId}.`,
    required: true,
    maxConcurrentChildren: 4,
    maxChildren: 8
  };
}

function commitBody(status: 'completed' | 'failed', content: string, toolCalls = 0) {
  return {
    status,
    assistant_message: { content, format: 'markdown' },
    usage: { input_tokens: 5, output_tokens: content ? 3 : 0, tool_calls: toolCalls },
    timing: { started_at: '2026-07-24T00:00:00.000Z', ended_at: '2026-07-24T00:00:01.000Z' }
  };
}

describe('delegated Workflow run persistence', () => {
  it('returns one child for concurrent identical tool-call delivery and rejects altered replay', async () => {
    const setup = await coordinatedRoot();
    const input = delegationInput(setup, 'tool-call-1');

    const deliveries = await Promise.all([
      createDelegatedWorkflowRun(input),
      createDelegatedWorkflowRun(input)
    ]);

    assert.equal(deliveries.filter((delivery) => delivery.created).length, 1);
    assert.equal(deliveries[0].run.id, deliveries[1].run.id);
    assert.equal((await listWorkflowChildRuns(setup.parent.id)).length, 1);
    const outbox = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM automation_dispatch_outbox WHERE run_id=$1',
      [deliveries[0].run.id]
    );
    assert.equal(Number(outbox.rows[0].count), 1);

    await assert.rejects(
      createDelegatedWorkflowRun({ ...input, taskPrompt: 'Altered replay payload.' }),
      (error: unknown) => error instanceof WorkflowDelegationConflictError
        && error.code === 'DELEGATION_IDEMPOTENCY_CONFLICT'
    );
  });

  it('enforces four active and eight total children under the coordinator lock', async () => {
    const setup = await coordinatedRoot();
    for (let index = 1; index <= 4; index += 1) {
      await createDelegatedWorkflowRun(delegationInput(setup, `active-${index}`));
    }
    await assert.rejects(
      createDelegatedWorkflowRun(delegationInput(setup, 'active-5')),
      (error: unknown) => error instanceof WorkflowDelegationConflictError
        && error.code === 'DELEGATION_CONCURRENCY_LIMIT'
    );

    await db.query(
      "UPDATE workflow_runs SET status='completed',ended_at=NOW() WHERE parent_run_id=$1",
      [setup.parent.id]
    );
    for (let index = 5; index <= 8; index += 1) {
      await createDelegatedWorkflowRun(delegationInput(setup, `total-${index}`));
    }
    await assert.rejects(
      createDelegatedWorkflowRun(delegationInput(setup, 'total-9')),
      (error: unknown) => error instanceof WorkflowDelegationConflictError
        && error.code === 'DELEGATION_TOTAL_LIMIT'
    );
    assert.equal((await listWorkflowChildRuns(setup.parent.id)).length, 8);
  });

  it('propagates required child pre-step waits while keeping optional waits local', async () => {
    const requiredSetup = await coordinatedRoot();
    const approvalSpecialist = {
      ...requiredSetup.specialist,
      approvalPolicy: { mode: 'always' as const, writeToolsRequireApproval: true }
    };
    const requiredChild = await createDelegatedWorkflowRun({
      ...delegationInput(requiredSetup, 'required-approval'),
      specialist: approvalSpecialist
    });
    const requiredExecution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [requiredSetup.parent.executionId]
    );
    assert.equal(requiredExecution.rows[0].status, 'waiting_for_approval');
    await updateWorkflowRun(requiredChild.run.id, { status: 'running' });
    const childCommit = await callController(commitRun, createRequest(
      { runId: requiredChild.run.id },
      commitBody('completed', 'Specialist completed.', 1)
    ));
    assert.equal(childCommit.statusCode, 200);
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [requiredSetup.parent.executionId]
    )).rows[0].status, 'running');

    await resetAutomationDatabaseFixtures();
    await installAutomationTemplateFixtures();
    const optionalSetup = await coordinatedRoot();
    await createDelegatedWorkflowRun({
      ...delegationInput(optionalSetup, 'optional-approval'),
      specialist: {
        ...optionalSetup.specialist,
        approvalPolicy: { mode: 'always' as const, writeToolsRequireApproval: true }
      },
      required: false
    });
    const optionalExecution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [optionalSetup.parent.executionId]
    );
    assert.equal(optionalExecution.rows[0].status, 'running');
  });

  it('reconciles an event-first terminal root commit exactly once', async () => {
    const setup = await coordinatedRoot();
    const child = await createDelegatedWorkflowRun(delegationInput(setup, 'event-first-child'));
    await updateWorkflowRun(child.run.id, { status: 'running' });
    mock.method(globalThis, 'fetch', async (input, init) => (
      init?.method === 'POST' && String(input).endsWith('/cancel')
        ? new Response(null, { status: 202 })
        : new Response('unexpected request', { status: 500 })
    ));
    await updateWorkflowRun(setup.parent.id, {
      status: 'failed',
      errorCode: 'MODEL_FAILED',
      errorMessage: 'Coordinator model failed.',
      endedAt: '2026-07-24T00:00:01.000Z'
    });
    const request = createRequest({ runId: setup.parent.id }, commitBody('failed', ''));

    const response = await callController(commitRun, request);
    const replay = await callController(commitRun, request);
    assert.equal(response.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [setup.parent.executionId]
    )).rows[0].status, 'failed');
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_runs WHERE id=$1',
      [child.run.id]
    )).rows[0].status, 'cancelled');
    assert.equal(Number((await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workflow_messages
       WHERE session_id=$1 AND role='assistant'`,
      [setup.parent.workflowSessionId]
    )).rows[0].count), 1);
    assert.equal(Number((await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_audit_events
       WHERE event_type='workflow.run_committed.v1' AND object_id=$1`,
      [setup.parent.id]
    )).rows[0].count), 1);
    assert.equal(Number((await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workflow_execution_events
       WHERE execution_id=$1 AND event_type='execution_status_changed'`,
      [setup.parent.executionId]
    )).rows[0].count), 1);
  });

  it('cancels every active graph run, pending dispatch, approval, and continuation', async () => {
    installWorkspace('admin');
    const cancelledRunIds: string[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      if (init?.method === 'POST' && String(input).includes('/cancel')) {
        cancelledRunIds.push(String(input).split('/').at(-2) || '');
        return new Response(null, { status: 202 });
      }
      return new Response('unexpected request', { status: 500 });
    });
    const setup = await coordinatedRoot();
    const child = await createDelegatedWorkflowRun(delegationInput(setup, 'cancel-child'));
    await updateWorkflowRun(child.run.id, { status: 'running' });
    const approval = await createAutomationRunApproval({
      workspaceId: child.run.workspaceId,
      runId: child.run.id,
      targetId: child.run.targetId,
      targetType: child.run.targetType,
      approvalKind: 'tool_write',
      toolCallId: 'cancelled-write',
      toolName: 'restart_workload',
      toolRef: { serverId: 'acornops-target-agent', toolName: 'restart_workload' },
      summary: 'This approval should be invalidated by cancellation.',
      arguments: {},
      requestedBy: actor.userId,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      continuationState: { cursor: 'before-cancelled-write' }
    });

    const response = await callController(
      cancelRun,
      createRequest({ runId: setup.parent.id })
    );
    assert.equal(response.statusCode, 202);
    const runs = await db.query<{ id: string; status: string }>(
      'SELECT id,status FROM workflow_runs WHERE execution_id=$1 ORDER BY id',
      [setup.parent.executionId]
    );
    assert.equal(runs.rows.every((run) => run.status === 'cancelled'), true);
    const execution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [setup.parent.executionId]
    );
    assert.equal(execution.rows[0].status, 'cancelled');
    assert.equal((await getAutomationRunApproval(approval.id))?.status, 'expired');
    assert.equal(await getAutomationRunContinuation(child.run.id), null);
    const childOutbox = await db.query<{ status: string }>(
      'SELECT status FROM automation_dispatch_outbox WHERE run_id=$1',
      [child.run.id]
    );
    assert.deepEqual(childOutbox.rows, [{ status: 'cancelled' }]);
    assert.deepEqual(
      cancelledRunIds.sort(),
      [setup.parent.id, child.run.id].sort()
    );
  });

  it('does not resurrect a run when cancellation wins an in-flight dispatch race', async () => {
    installWorkspace('admin');
    const setup = await coordinatedRoot();
    const child = await createDelegatedWorkflowRun(delegationInput(setup, 'dispatch-race-child'));
    let cancellationIssued = false;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.endsWith('/cancel')) return new Response(null, { status: 202 });
      if (init?.method === 'POST' && url.endsWith('/api/v1/runs')) {
        cancellationIssued = true;
        const response = await callController(
          cancelWorkflowExecution,
          createRequest({ executionId: setup.parent.executionId })
        );
        assert.equal(response.statusCode, 202);
        return new Response(null, { status: 202 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    assert.equal(await runAutomationOutboxTick(), 1);
    assert.equal(cancellationIssued, true);
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_runs WHERE id=$1',
      [child.run.id]
    )).rows[0].status, 'cancelled');
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [setup.parent.executionId]
    )).rows[0].status, 'cancelled');
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM automation_dispatch_outbox WHERE run_id=$1',
      [child.run.id]
    )).rows[0].status, 'cancelled');
    const lateCommit = await callController(commitRun, createRequest(
      { runId: child.run.id },
      commitBody('completed', 'Late specialist output.')
    ));
    assert.equal(lateCommit.statusCode, 200);
    assert.equal((await db.query<{ status: string }>(
      'SELECT status FROM workflow_runs WHERE id=$1',
      [child.run.id]
    )).rows[0].status, 'cancelled');
  });

  it('propagates required child review state while keeping optional child review local', async () => {
    const requiredSetup = await coordinatedRoot();
    const requiredChild = await createDelegatedWorkflowRun(
      delegationInput(requiredSetup, 'required-review')
    );
    await updateWorkflowRun(requiredChild.run.id, { status: 'needs_review' });
    await recomputeWorkflowExecutionStatusForRun(requiredChild.run.id);
    const requiredExecution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [requiredSetup.parent.executionId]
    );
    assert.equal(requiredExecution.rows[0].status, 'needs_review');

    await resetAutomationDatabaseFixtures();
    await installAutomationTemplateFixtures();
    const optionalSetup = await coordinatedRoot();
    const optionalChild = await createDelegatedWorkflowRun({
      ...delegationInput(optionalSetup, 'optional-review'),
      required: false
    });
    await updateWorkflowRun(optionalChild.run.id, { status: 'needs_review' });
    await recomputeWorkflowExecutionStatusForRun(optionalChild.run.id);
    const optionalExecution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [optionalSetup.parent.executionId]
    );
    assert.equal(optionalExecution.rows[0].status, 'running');
  });
});
