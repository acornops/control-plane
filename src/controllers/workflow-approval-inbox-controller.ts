import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { incrementApprovalInboxQuery, observeApprovalInboxQueryDurationMs } from '../metrics.js';
import {
  countPendingWorkspaceAutomationApprovals,
  listWorkspaceAutomationApprovals,
  type AutomationRunApproval
} from '../store/repository-automation-approvals.js';
import { repo } from '../store/repository.js';
import type { RunToolApproval } from '../types/domain.js';
import type { WorkflowApprovalInboxResponse, WorkflowApprovalInboxRow } from '../types/workflows.js';
import { toSingleParam } from '../utils/params.js';

function targetApprovalInboxRow(approval: RunToolApproval): WorkflowApprovalInboxRow {
  return {
    approvalId: approval.id,
    runId: approval.runId,
    source: 'target_tool',
    targetId: approval.targetId,
    targetType: approval.targetType,
    summary: approval.summary || `Run ${approval.toolName}`,
    toolName: approval.toolName,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    status: approval.status,
    decision: approval.decision,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    requestedAt: approval.createdAt
  };
}

function automationApprovalInboxRow(approval: AutomationRunApproval): WorkflowApprovalInboxRow {
  return {
    approvalId: approval.id,
    runId: approval.runId,
    source: approval.approvalKind === 'pre_step' ? 'workflow_gate' : 'workflow_tool',
    targetId: approval.targetId,
    targetType: approval.targetType,
    summary: approval.summary,
    toolName: approval.toolName,
    requestedBy: approval.requestedBy,
    expiresAt: approval.expiresAt,
    status: approval.status,
    decision: approval.decision,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    requestedAt: approval.createdAt
  };
}

export async function listWorkspaceApprovalInbox(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startedAt = Date.now();
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const status = rawStatus === 'decided' || rawStatus === 'all' ? rawStatus : 'pending';
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceDataRead(req, res, workspaceId, 'No access to approvals'))) {
      incrementApprovalInboxQuery(status, 'denied');
      observeApprovalInboxQueryDurationMs(status, 'denied', Date.now() - startedAt);
      return;
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const runId = typeof req.query.runId === 'string' && req.query.runId.trim() ? req.query.runId.trim() : undefined;
    const approvalId = typeof req.query.approvalId === 'string' && req.query.approvalId.trim() ? req.query.approvalId.trim() : undefined;
    const [targetApprovals, pendingTargetCount, automationApprovals, pendingAutomationCount] = await Promise.all([
      repo.listWorkspaceRunToolApprovals({ workspaceId, status, limit, cursor, ...(runId ? { runId } : {}), ...(approvalId ? { approvalId } : {}) }),
      repo.countPendingWorkspaceRunToolApprovals(workspaceId),
      listWorkspaceAutomationApprovals({ workspaceId, status, limit, cursor }),
      countPendingWorkspaceAutomationApprovals(workspaceId)
    ]);
    const items = [...targetApprovals.map(targetApprovalInboxRow), ...automationApprovals.map(automationApprovalInboxRow)]
      .filter((approval) => (!runId || approval.runId === runId) && (!approvalId || approval.approvalId === approvalId))
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, limit);
    incrementApprovalInboxQuery(status, 'success');
    observeApprovalInboxQueryDurationMs(status, 'success', Date.now() - startedAt);
    const response: WorkflowApprovalInboxResponse = {
      items,
      pendingCount: pendingTargetCount + pendingAutomationCount,
      ...(items.length === limit && items[items.length - 1]?.requestedAt ? { nextCursor: items[items.length - 1].requestedAt } : {})
    };
    res.status(200).json(response);
  } catch (err) {
    incrementApprovalInboxQuery(status, 'error');
    observeApprovalInboxQueryDurationMs(status, 'error', Date.now() - startedAt);
    next(err);
  }
}
