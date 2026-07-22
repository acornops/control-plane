import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { incrementAutomationApproval } from '../metrics.js';
import {
  applyAutomationApprovalOutcome,
  decideAutomationRunApproval,
  type AutomationRunApproval
} from '../store/repository-automation-approvals.js';
import { runAuditActor } from './run-actor.js';
import { getWorkflowRun } from '../store/repository-workflows.js';
import { recordWorkflowExecutionEvent } from '../services/workflow-execution-events.js';

export async function decideAutomationApprovalRequest(
  req: AuthenticatedRequest,
  res: Response,
  approval: AutomationRunApproval
): Promise<void> {
  const authz = await requireWorkspaceDataRead(req, res, approval.workspaceId, 'No access to run');
  if (!authz) return;

  if (approval.status !== 'pending') {
    await applyAutomationApprovalOutcome(approval);
    if (approval.decision === req.body.decision) {
      res.status(200).json(approval);
      return;
    }
    res.status(409).json({
      error: {
        code: approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_ALREADY_DECIDED',
        message: `Approval is already ${approval.status}`,
        retryable: false
      },
      approval
    });
    return;
  }

  const isRequesterRejecting = req.body.decision === 'rejected' && approval.requestedBy === req.auth.userId;
  if (!authz.can('create_read_write_runs') && !isRequesterRejecting) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Only workspace roles with read-write run capability can approve automation actions',
        retryable: false
      }
    });
    return;
  }

  const decided = await decideAutomationRunApproval(approval.id, req.body.decision, req.auth.userId);
  if (!decided) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
    return;
  }
  await applyAutomationApprovalOutcome(decided);
  incrementAutomationApproval(decided.approvalKind, decided.status);
  const auditActor = runAuditActor(req);
  const workflowRun = decided.sourceType === 'workflow'
    ? await getWorkflowRun(decided.runId)
    : null;
  await recordWorkspaceAuditEvent({
    workspaceId: decided.workspaceId,
    category: 'approval',
    eventType: `${decided.sourceType}.${decided.approvalKind}_approval_decided.v1`,
    operation: 'write',
    ...auditActor,
    objectType: 'automation_approval',
    objectId: decided.id,
    objectName: decided.toolName,
    summary: 'Automation approval decided',
    metadata: {
      source: decided.sourceType,
      sourceId: decided.sourceId,
      runId: decided.runId,
      approvalKind: decided.approvalKind,
      decision: decided.decision || decided.status,
      status: decided.status,
      decisionActorType: auditActor.actorType || 'user',
      ...(workflowRun
        ? {
            workflowId: workflowRun.workflowId,
            workflowExecutionId: workflowRun.executionId,
            workflowSessionId: workflowRun.workflowSessionId,
            agentId: workflowRun.agentId || null,
            attemptNumber: workflowRun.attemptNumber
          }
        : {}),
      ...(req.auth.credential.type === 'external_integration'
        ? {
            externalIntegrationClientId: req.auth.credential.integrationId,
            externalIntegrationLinkId: req.auth.credential.linkId
          }
        : {})
    }
  });
  if (workflowRun) {
    await recordWorkflowExecutionEvent({
      executionId: workflowRun.executionId,
      workspaceId: workflowRun.workspaceId,
      type: 'approval_decided',
      runId: workflowRun.id,
      approvalId: decided.id,
      dedupeKey: `approval-decided:${decided.id}:${decided.status}`,
      payload: {
        approvalKind: decided.approvalKind,
        status: decided.status,
        decision: decided.decision || null
      }
    });
  }
  if (decided.status === 'expired') {
    res.status(409).json({
      error: { code: 'APPROVAL_EXPIRED', message: 'Approval expired before the decision was recorded', retryable: false },
      approval: decided
    });
    return;
  }
  res.status(200).json(decided);
}
