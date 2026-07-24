import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { db } from '../src/infra/db.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import {
  applyAutomationApprovalOutcome,
  AutomationApprovalConflictError,
  createAutomationRunApproval,
  decideAutomationRunApproval,
  decideAutomationRunApprovalOutcome,
  expirePendingAutomationRunApprovals,
  getAutomationRunApproval,
  getAutomationRunContinuation,
  listAutomationRunApprovals,
  startAutomationApprovalExecution
} from '../src/store/repository-automation-approvals.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  getWorkflowRun,
  updateWorkflowRun
} from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

async function createDirectRoot(approvalRequirements: string[] = []) {
  const storedWorkflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
  const specialist = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
  assert.ok(storedWorkflow);
  assert.ok(specialist);
  const workflow = {
    ...storedWorkflow,
    capabilityPolicy: {
      ...storedWorkflow.capabilityPolicy,
      mode: 'read_write' as const,
      approvalRequirements
    }
  };
  const compiledAccessScope = compileWorkflowAccessScope({
    workflow,
    selectedAgents: [specialist],
    specialistAgent: specialist,
    mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
    targetRoute: { id: 'cluster-1', targetType: 'kubernetes' },
    actor,
    approvedContextGrants: ['workspace_metadata', 'target_inventory']
  });
  const session = await createWorkflowSession({ workflow, createdBy: actor.userId, compiledAccessScope });
  return createWorkflowExecution({
    workflow,
    session,
    compiledAccessScope,
    content: 'Collect signals.',
    promptDigest: digestPrompt('Collect signals.'),
    bindingDigest: digestBindings([]),
    resourceBindings: [],
    resolvedAt: new Date().toISOString(),
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    specialistSnapshot: specialist
  });
}

describe('durable Workflow run approvals', () => {
  it('creates a pre-step approval, run, and outbox atomically and decides concurrent retries once', async () => {
    const created = await createDirectRoot(['Approve this Workflow run']);
    assert.equal(created.run.status, 'waiting_for_approval');
    const approvals = await listAutomationRunApprovals(created.run.id);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].approvalKind, 'pre_step');
    assert.equal(approvals[0].status, 'pending');
    const outbox = await db.query<{ status: string; source_id: string }>(
      'SELECT status,source_id FROM automation_dispatch_outbox WHERE run_id=$1',
      [created.run.id]
    );
    assert.deepEqual(outbox.rows, [{ status: 'pending', source_id: created.execution.id }]);

    const concurrent = await Promise.all([
      decideAutomationRunApprovalOutcome(approvals[0].id, 'approved', actor.userId),
      decideAutomationRunApprovalOutcome(approvals[0].id, 'approved', actor.userId)
    ]);
    assert.equal(concurrent.filter((outcome) => outcome?.transitioned).length, 1);
    assert.deepEqual(concurrent.map((outcome) => outcome?.approval.status), ['approved', 'approved']);
    const conflict = await decideAutomationRunApprovalOutcome(approvals[0].id, 'rejected', actor.userId);
    assert.equal(conflict?.transitioned, false);
    assert.equal(conflict?.approval.decision, 'approved');
    await applyAutomationApprovalOutcome(concurrent[0]!.approval);
    assert.equal((await getWorkflowRun(created.run.id))?.status, 'queued');
  });

  it('marks duplicate write execution starts as needs_review and resumes through the logical execution', async () => {
    const created = await createDirectRoot();
    await updateWorkflowRun(created.run.id, { status: 'running' });
    await db.query(
      "UPDATE workflow_executions SET status='running' WHERE id=$1",
      [created.execution.id]
    );
    await db.query(
      "UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1",
      [created.run.id]
    );
    const approval = await createAutomationRunApproval({
      workspaceId: created.run.workspaceId,
      runId: created.run.id,
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      approvalKind: 'tool_write',
      toolCallId: 'tool-call-1',
      toolName: 'restart_workload',
      toolRef: { serverId: 'acornops-target-agent', toolName: 'restart_workload' },
      summary: 'Restart the approved workload.',
      arguments: { namespace: 'default', name: 'api' },
      requestedBy: actor.userId,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      continuationState: { cursor: 'before-tool-call' }
    });
    const replay = await createAutomationRunApproval({
      workspaceId: created.run.workspaceId,
      runId: created.run.id,
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      approvalKind: 'tool_write',
      toolCallId: 'tool-call-1',
      toolName: 'restart_workload',
      toolRef: { serverId: 'acornops-target-agent', toolName: 'restart_workload' },
      summary: 'Restart the approved workload.',
      arguments: { namespace: 'default', name: 'api' },
      requestedBy: actor.userId,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      continuationState: { cursor: 'before-tool-call' }
    });
    assert.equal(replay.id, approval.id);
    await assert.rejects(
      createAutomationRunApproval({
        workspaceId: created.run.workspaceId,
        runId: created.run.id,
        targetId: 'cluster-1',
        targetType: 'kubernetes',
        approvalKind: 'tool_write',
        toolCallId: 'tool-call-1',
        toolName: 'restart_workload',
        toolRef: { serverId: 'acornops-target-agent', toolName: 'restart_workload' },
        summary: 'Restart the approved workload.',
        arguments: { namespace: 'other', name: 'api' },
        requestedBy: actor.userId,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        continuationState: { cursor: 'before-tool-call' }
      }),
      (error: unknown) => error instanceof AutomationApprovalConflictError
    );
    assert.equal((await getWorkflowRun(created.run.id))?.status, 'waiting_for_approval');
    assert.deepEqual((await getAutomationRunContinuation(created.run.id))?.state, {
      cursor: 'before-tool-call'
    });

    const decided = await decideAutomationRunApproval(approval.id, 'approved', actor.userId);
    assert.ok(decided);
    await applyAutomationApprovalOutcome(decided);
    const resumeOutbox = await db.query<{ source_id: string }>(
      "SELECT source_id FROM automation_dispatch_outbox WHERE run_id=$1 AND payload->>'resume'='true'",
      [created.run.id]
    );
    assert.deepEqual(resumeOutbox.rows, [{ source_id: created.execution.id }]);
    await db.query(
      "UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1",
      [created.run.id]
    );
    await updateWorkflowRun(created.run.id, { status: 'running' });

    assert.equal(
      (await startAutomationApprovalExecution(approval.id, async () => 'signed-receipt'))?.approval.executionStatus,
      'executing'
    );
    await assert.rejects(
      startAutomationApprovalExecution(approval.id, async () => 'must-not-sign'),
      /APPROVAL_EXECUTION_ALREADY_STARTED/
    );
    const duplicateStart = await getAutomationRunApproval(approval.id);
    assert.equal(duplicateStart?.executionStatus, 'unknown');
    assert.equal((await getWorkflowRun(created.run.id))?.status, 'needs_review');
    const execution = await db.query<{ status: string }>(
      'SELECT status FROM workflow_executions WHERE id=$1',
      [created.execution.id]
    );
    assert.equal(execution.rows[0].status, 'needs_review');
    const pending = await db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM automation_dispatch_outbox WHERE run_id=$1 AND status='pending'",
      [created.run.id]
    );
    assert.equal(Number(pending.rows[0].count), 0);
  });

  it('fails the root and execution when a durable write approval expires', async () => {
    const created = await createDirectRoot();
    await updateWorkflowRun(created.run.id, { status: 'running' });
    await db.query("UPDATE workflow_executions SET status='running' WHERE id=$1", [created.execution.id]);
    await db.query(
      "UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1",
      [created.run.id]
    );
    await createAutomationRunApproval({
      workspaceId: created.run.workspaceId,
      runId: created.run.id,
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      approvalKind: 'tool_write',
      toolCallId: 'workflow-write-1',
      toolName: 'restart_workload',
      toolRef: { serverId: 'acornops-target-agent', toolName: 'restart_workload' },
      summary: 'Approve the exact target mutation.',
      arguments: {},
      requestedBy: actor.userId,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      continuationState: { cursor: 'before-workflow-write' }
    });

    const [expired] = await expirePendingAutomationRunApprovals();
    assert.equal(expired.status, 'expired');
    await applyAutomationApprovalOutcome(expired);
    const run = await getWorkflowRun(created.run.id);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.errorCode, 'APPROVAL_EXPIRED');
    const execution = await db.query<{ status: string; error_code: string }>(
      'SELECT status,error_code FROM workflow_executions WHERE id=$1',
      [created.execution.id]
    );
    assert.deepEqual(execution.rows[0], {
      status: 'failed',
      error_code: 'APPROVAL_EXPIRED'
    });
  });
});
