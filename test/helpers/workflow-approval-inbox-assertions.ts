import assert from 'node:assert/strict';
import { listWorkspaceApprovalInbox } from '../../src/controllers/workflow-schedules-controller.js';
import { repo } from '../../src/store/repository.js';
import type { Run, RunToolApproval } from '../../src/types/domain.js';
import type { WorkflowApprovalRecord, WorkflowRunRecord } from '../../src/store/repository-workflows.js';
import { callController, createRequest } from './controller-regression-fixtures.js';

export async function assertFocusedApprovalInboxFilters(input: {
  targetApproval: RunToolApproval;
  targetRun: Run;
  workflowApproval: WorkflowApprovalRecord;
  workflowRun: WorkflowRunRecord;
}): Promise<void> {
  let targetQuery: Parameters<typeof repo.listWorkspaceRunToolApprovals>[0] | undefined;
  repo.listWorkspaceRunToolApprovals = async (params) => {
    targetQuery = params;
    if (params.runId && params.runId !== input.targetApproval.runId) return [];
    if (params.approvalId && params.approvalId !== input.targetApproval.id) return [];
    return [input.targetApproval];
  };
  const targetResponse = await callController(listWorkspaceApprovalInbox, {
    ...createRequest({ workspaceId: 'workspace-1' }),
    query: { runId: input.targetRun.id, approvalId: input.targetApproval.id }
  });
  assert.equal(targetResponse.statusCode, 200);
  assert.equal(targetQuery?.runId, input.targetRun.id);
  assert.equal(targetQuery?.approvalId, input.targetApproval.id);
  assert.deepEqual(
    (targetResponse.body as { items: Array<{ approvalId: string; source: string; runId: string }> }).items
      .map(({ approvalId, source, runId }) => ({ approvalId, source, runId })),
    [{ approvalId: input.targetApproval.id, source: 'target_tool', runId: input.targetRun.id }]
  );

  repo.listWorkspaceRunToolApprovals = async () => [];
  const workflowResponse = await callController(listWorkspaceApprovalInbox, {
    ...createRequest({ workspaceId: 'workspace-1' }),
    query: { runId: input.workflowRun.id, approvalId: input.workflowApproval.id }
  });
  assert.equal(workflowResponse.statusCode, 200);
  assert.deepEqual(
    (workflowResponse.body as { items: Array<{ approvalId: string; source: string; runId: string }> }).items
      .map(({ approvalId, source, runId }) => ({ approvalId, source, runId })),
    [{ approvalId: input.workflowApproval.id, source: 'workflow_gate', runId: input.workflowRun.id }]
  );
}
