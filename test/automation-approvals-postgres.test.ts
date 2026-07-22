import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { db } from '../src/infra/db.js';
import { compileAgentRunScope } from '../src/services/agent-access.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { digestBindings, digestPrompt } from '../src/services/prompt-resources/registry.js';
import {
  createAgentDefinition,
  createAgentRunActivity,
  getAgentActivityRecord,
  getAgentDefinition,
  listAgentDefinitions,
  updateAgentActivityRecord
} from '../src/store/repository-agents.js';
import {
  applyAutomationApprovalOutcome,
  createAutomationRunApproval,
  decideAutomationRunApproval,
  expirePendingAutomationRunApprovals,
  getAutomationRunApproval,
  getAutomationRunContinuation,
  listAutomationRunApprovals,
  startAutomationApprovalExecution
} from '../src/store/repository-automation-approvals.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  getWorkflowRun
} from '../src/store/repository-workflows.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const adminActor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

describe('durable automation approvals', () => {
  it('commits an Agent pre-step approval, run, and outbox atomically and idempotently', async () => {
    const agent = await getAgentDefinition('workspace-1', 'agent-incident-reporter');
    assert.ok(agent);
    const approvalAgent = {
      ...agent,
      approvalPolicy: { mode: 'always' as const, writeToolsRequireApproval: true }
    };
    const compiledScope = compileAgentRunScope({
      agent: approvalAgent,
      actor: adminActor,
      approvedContextGrants: [],
      mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true })
    });
    const input = {
      agent: approvalAgent,
      triggeredBy: { type: 'user' as const, userId: 'user-1' },
      prompt: 'Create the incident report.',
      inputContext: { chatSessionIds: ['session-1'] },
      compiledScope,
      clientRequestId: 'agent-pre-step-idempotency-1'
    };

    const run = await createAgentRunActivity(input);
    const duplicate = await createAgentRunActivity(input);

    assert.equal(duplicate.id, run.id);
    assert.equal(run.status, 'waiting_for_approval');
    const approvals = await listAutomationRunApprovals('agent', run.id);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].approvalKind, 'pre_step');
    assert.equal(approvals[0].status, 'pending');
    const lifetimeSeconds = (new Date(approvals[0].expiresAt).getTime() - new Date(approvals[0].createdAt).getTime()) / 1000;
    assert.ok(lifetimeSeconds >= 895 && lifetimeSeconds <= 905);

    const outbox = await db.query<{ status: string }>(
      'SELECT status FROM automation_dispatch_outbox WHERE run_id=$1',
      [run.id]
    );
    assert.deepEqual(outbox.rows.map((row) => row.status), ['pending']);

    const decided = await decideAutomationRunApproval(approvals[0].id, 'approved', 'user-1');
    assert.ok(decided);
    await applyAutomationApprovalOutcome(decided);
    assert.equal((await getAgentActivityRecord(run.id))?.status, 'queued');
  });

  it('marks duplicate write execution starts as needs_review without queuing another write', async () => {
    const agent = await createAgentDefinition({
      workspaceId: 'workspace-1',
      name: 'Write approval probe',
      instructions: 'Exercise a write tool only after approval.',
      ownerUserId: 'user-1',
      createdBy: 'user-1',
      tools: ['reports.pdf.generate'],
      approvalPolicy: { mode: 'none', writeToolsRequireApproval: false }
    });
    const compiledScope = compileAgentRunScope({ agent, actor: adminActor, approvedContextGrants: [] });
    const run = await createAgentRunActivity({
      agent,
      triggeredBy: { type: 'user', userId: 'user-1' },
      prompt: 'Write the approved report.',
      inputContext: {},
      compiledScope,
      clientRequestId: 'uncertain-write-agent-1'
    });
    await updateAgentActivityRecord(run.id, { status: 'running' });
    await db.query("UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1", [run.id]);

    const approval = await createAutomationRunApproval({
      workspaceId: run.workspaceId,
      sourceType: 'agent',
      sourceId: run.agentId,
      runId: run.id,
      approvalKind: 'tool_write',
      toolCallId: 'tool-call-1',
      toolName: 'reports.pdf.generate',
      toolRef: { serverId: '955a5e17-5424-48e1-99ab-fdf8415a3a30', toolName: 'reports.pdf.generate' },
      summary: 'Generate the approved report source.',
      arguments: { reportId: 'report-1' },
      requestedBy: 'user-1',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      continuationState: { cursor: 'before-tool-call' }
    });
    assert.equal((await getAgentActivityRecord(run.id))?.status, 'waiting_for_approval');
    assert.deepEqual((await getAutomationRunContinuation('agent', run.id))?.state, { cursor: 'before-tool-call' });

    const decided = await decideAutomationRunApproval(approval.id, 'approved', 'user-1');
    assert.ok(decided);
    await applyAutomationApprovalOutcome(decided);
    await db.query("UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1", [run.id]);
    await updateAgentActivityRecord(run.id, { status: 'running' });

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
    assert.equal((await getAgentActivityRecord(run.id))?.status, 'needs_review');
    await applyAutomationApprovalOutcome(duplicateStart!);

    const pending = await db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM automation_dispatch_outbox WHERE run_id=$1 AND status='pending'",
      [run.id]
    );
    assert.equal(Number(pending.rows[0].count), 0);
  });

  it('fails a Workflow attempt when a durable write approval expires', async () => {
    const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.ok(workflow);
    const agents = await listAgentDefinitions('workspace-1');
    const agent = agents.find((candidate) => candidate.id === workflow.entryAgentId);
    assert.ok(agent);
    const compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      entryAgent: agent,
      mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
      targetRoute: { id: 'cluster-1', targetType: 'kubernetes' },
      actor: adminActor,
      approvedContextGrants: ['workspace_metadata', 'target_inventory']
    });
    const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
    const created = await createWorkflowExecution({
      workflow,
      session,
      content: 'Collect signals.',
      promptDigest: digestPrompt('Collect signals.'),
      bindingDigest: digestBindings([]),
      resourceBindings: [],
      resolvedAt: new Date().toISOString(),
      inputs: { targetId: 'cluster-1' },
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      agentSnapshot: agent as unknown as Record<string, unknown>
    });
    await db.query("UPDATE workflow_runs SET status='running' WHERE id=$1", [created.run.id]);
    await db.query("UPDATE workflow_executions SET status='running' WHERE id=$1", [created.execution.id]);
    await db.query("UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1", [created.run.id]);

    await createAutomationRunApproval({
      workspaceId: created.run.workspaceId,
      sourceType: 'workflow',
      sourceId: created.execution.id,
      runId: created.run.id,
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      approvalKind: 'tool_write',
      toolCallId: 'workflow-write-1',
      toolName: 'repository.commit.create',
      toolRef: { serverId: 'f3028f15-7c06-4763-8c17-f70a7be86678', toolName: 'repository.commit.create' },
      summary: 'Approve the exact repository commit.',
      arguments: {},
      requestedBy: 'user-1',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      continuationState: { cursor: 'before-workflow-write' }
    });

    const expired = await expirePendingAutomationRunApprovals();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].status, 'expired');
    await applyAutomationApprovalOutcome(expired[0]);

    const run = await getWorkflowRun(created.run.id);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.errorCode, 'APPROVAL_EXPIRED');
    const execution = await db.query<{ status: string; error_code: string }>(
      'SELECT status,error_code FROM workflow_executions WHERE id=$1',
      [created.execution.id]
    );
    assert.deepEqual(execution.rows[0], { status: 'failed', error_code: 'APPROVAL_EXPIRED' });
  });
});
