import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { getWorkspacePermissions } from '../src/auth/authorization.js';
import { listRunApprovals, decideRunApproval } from '../src/controllers/runs-controller.js';
import { listWorkspaceApprovalInbox } from '../src/controllers/workspace-approval-inbox-controller.js';
import { publicRunApproval } from '../src/controllers/external-run-public.js';
import { db } from '../src/infra/db.js';
import { compileWorkflowAccessScope } from '../src/services/workflow-access.js';
import { repo } from '../src/store/repository.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { createAutomationRunApproval, decideAutomationRunApprovalOutcome } from '../src/store/repository-automation-approvals.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import { createWorkflowExecution, createWorkflowSession, getWorkflowDefinition } from '../src/store/repository-workflows.js';
import { resetAutomationDatabaseFixtures, installAutomationTemplateFixtures, closeAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';
import { callController, createRequest, restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
  await db.query("INSERT INTO users(id,email,display_name) VALUES('approval-actor','private@example.test','Historical operator') ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name");
});
afterEach(() => {
  mock.restoreAll();
  restoreControllerRegressionState();
});
after(closeAutomationDatabaseFixtures);

async function interactiveApproval(targetId = 'cluster-1') {
  const session = await repo.addSession('workspace-1', targetId, 'user-1', 'Approval context');
  const message = await repo.addMessage(session.id, 'user', 'Restart this target');
  const run = await repo.addRun({
    id: randomUUID(), workspaceId: 'workspace-1', targetId,
    sessionId: session.id, messageId: message.id, toolAccessMode: 'read_write',
    llmProvider: 'openai', llmModel: 'gpt-5-nano', llmReasoningSummaryMode: 'off', llmReasoningEffort: 'low',
    status: 'running', requestedAt: new Date().toISOString()
  });
  return repo.createRunToolApproval({
    runId: run.id, workspaceId: run.workspaceId, targetId,
    toolCallId: 'write-1', toolName: 'restart_workload',
    toolRef: { serverId: 'server-operations', toolName: 'restart_workload' },
    arguments: {}, requestedBy: 'approval-actor', expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
}

async function workflowApproval() {
  const workflow = await getWorkflowDefinition('workspace-1', 'cluster-triage');
  const specialist = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
  assert.ok(workflow);
  assert.ok(specialist);
  const compiledAccessScope = compileWorkflowAccessScope({
    workflow, selectedAgents: [specialist], specialistAgent: specialist,
    mappings: await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }),
    actor: { userId: 'user-1', role: 'admin', permissions: getWorkspacePermissions('admin') }
  });
  const session = await createWorkflowSession({ workflow, createdBy: 'user-1', compiledAccessScope });
  const { run } = await createWorkflowExecution({ workflow, session, compiledAccessScope, content: 'Inspect', specialistSnapshot: specialist });
  return createAutomationRunApproval({
    workspaceId: run.workspaceId, runId: run.id, approvalKind: 'pre_step',
    toolCallId: 'gate-1', toolName: 'workflow.approval_gate', summary: 'Confirm inspection',
    requestedBy: 'approval-actor', expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
}

describe('approval presentation context', () => {
  it('shows historical actors and target context while preserving an approved but failed execution', async () => {
    const approval = await interactiveApproval();
    await repo.decideRunToolApprovalOutcome(approval.id, 'approved', 'user-1');
    await db.query("UPDATE run_tool_approvals SET execution_status='failed' WHERE id=$1", [approval.id]);
    const response = await callController(listWorkspaceApprovalInbox, { ...createRequest({ workspaceId: 'workspace-1' }), query: { status: 'all' } });
    assert.equal(response.statusCode, 200);
    const row = (response.body as { items: Record<string, unknown>[] }).items[0];
    assert.deepEqual(row.requestedByUser, { id: 'approval-actor', displayName: 'Historical operator' });
    assert.deepEqual(row.decidedByUser, { id: 'user-1', displayName: 'Test User' });
    assert.equal(row.workspaceName, 'Test Workspace');
    assert.equal(row.targetName, 'Test Cluster');
    assert.equal(row.targetId, 'cluster-1');
    assert.equal(row.targetType, 'kubernetes');
    assert.equal(row.status, 'approved');
    assert.equal(row.executionStatus, 'failed');
    assert.equal(row.requestedBy, 'approval-actor');
    assert.doesNotMatch(JSON.stringify(response.body), /private@example|email/);
    const detail = await callController(listRunApprovals, createRequest({ runId: approval.runId }));
    const [item] = detail.body as Record<string, unknown>[];
    assert.deepEqual(item.requestedByUser, row.requestedByUser);
    assert.deepEqual(item.toolRef, { serverId: 'server-operations', toolName: 'restart_workload' });
    assert.equal(item.targetName, 'Test Cluster');
    assert.equal(item.executionStatus, 'failed');
    const decision = await callController(decideRunApproval, createRequest({ runId: approval.runId, approvalId: approval.id }, { decision: 'approved' }));
    assert.equal(decision.statusCode, 200);
    assert.deepEqual((decision.body as Record<string, unknown>).decidedByUser, row.decidedByUser);
  });

  it('enriches workflow gates without inventing a target, including decision results', async () => {
    const approval = await workflowApproval();
    const decided = await decideAutomationRunApprovalOutcome(approval.id, 'rejected', 'user-1');
    assert.deepEqual((decided?.approval as unknown as Record<string, unknown>).decidedByUser, { id: 'user-1', displayName: 'Test User' });
    const response = await callController(listRunApprovals, createRequest({ runId: approval.runId }));
    const [item] = response.body as Record<string, unknown>[];
    assert.deepEqual(item.requestedByUser, { id: 'approval-actor', displayName: 'Historical operator' });
    assert.equal(item.workspaceName, 'Test Workspace');
    assert.equal(item.targetName, undefined);
    const inbox = await callController(listWorkspaceApprovalInbox, { ...createRequest({ workspaceId: 'workspace-1' }), query: { status: 'all' } });
    const [row] = (inbox.body as { items: Record<string, unknown>[] }).items;
    assert.deepEqual(row.requestedByUser, item.requestedByUser);
    assert.equal(row.executionStatus, 'not_started');
    assert.equal(row.targetId, undefined);
  });

  it('retains stable IDs when a referenced user is missing', async () => {
    const approval = await interactiveApproval();
    await db.query("DELETE FROM users WHERE id='approval-actor'");
    const response = await callController(listRunApprovals, createRequest({ runId: approval.runId }));
    const [item] = response.body as Record<string, unknown>[];
    assert.equal(item.requestedBy, 'approval-actor');
    assert.equal(item.requestedByUser, undefined);
    assert.equal(item.workspaceName, 'Test Workspace');
  });

  it('does not query approvals or context after workspace authorization fails', async () => {
    const approval = await interactiveApproval();
    mock.method(repo, 'getWorkspaceRole', async () => undefined);
    mock.method(repo, 'listRunToolApprovals', async () => { assert.fail('Approval lookup must follow authorization'); });
    const response = await callController(listRunApprovals, createRequest({ runId: approval.runId }));
    assert.equal(response.statusCode, 403);
  });

  it('keeps external integration approval responses on their existing display-safe allowlist', async () => {
    const approval = await interactiveApproval();
    const enriched = await repo.getRunToolApproval(approval.id);
    assert.ok(enriched);
    assert.equal(enriched.requestedByUser?.displayName, 'Historical operator');
    const external = publicRunApproval(enriched);
    assert.equal(external.requestedByUser, undefined);
    assert.equal(external.workspaceName, undefined);
    assert.equal(external.targetName, undefined);
    assert.equal(external.executionStatus, 'not_started');
    assert.equal(external.id, approval.id);
  });

  it('keeps inbox queries bounded as the page grows and cannot expose another workspace name', async () => {
    const approval = await interactiveApproval();
    const originalQuery = db.query;
    let queryCount = 0;
    mock.method(db, 'query', async (sql: string, values?: unknown[]) => {
      queryCount += 1;
      return originalQuery.call(db, sql, values);
    });
    const request = { ...createRequest({ workspaceId: 'workspace-1' }), query: { status: 'all' } };
    const first = await callController(listWorkspaceApprovalInbox, request);
    assert.equal((first.body as { items: unknown[] }).items.length, 1);
    const singleRowQueries = queryCount;
    await db.query(
      `INSERT INTO run_tool_approvals (
         id,run_id,workspace_id,target_id,tool_call_id,tool_name,server_id,server_tool_name,
         requested_tool_alias,arguments_digest,arguments,status,execution_status,requested_by,created_at,expires_at
       ) SELECT $1,run_id,workspace_id,target_id,'write-2',tool_name,server_id,server_tool_name,
         requested_tool_alias,arguments_digest,arguments,status,execution_status,requested_by,created_at,expires_at
         FROM run_tool_approvals WHERE id=$2`, [randomUUID(), approval.id]
    );
    queryCount = 0;
    const second = await callController(listWorkspaceApprovalInbox, request);
    assert.equal((second.body as { items: unknown[] }).items.length, 2);
    assert.equal(queryCount, singleRowQueries);
    const otherWorkspace = await callController(listWorkspaceApprovalInbox, { ...request, params: { workspaceId: 'workspace-2' } });
    assert.deepEqual((otherWorkspace.body as { items: unknown[] }).items, []);
    assert.doesNotMatch(JSON.stringify(otherWorkspace.body), /Historical operator|Test Cluster|Test Workspace/);
  });
});
