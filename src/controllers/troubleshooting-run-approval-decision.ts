import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { recordApprovalActivity } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, Run } from '../types/domain.js';
import { redispatchWaitingRunAfterApproval } from './run-controller-helpers.js';
import { runAuditActor } from './run-actor.js';

export async function decideTroubleshootingRunApproval(
  req: AuthenticatedRequest,
  res: Response,
  run: Run,
  approvalId: string
): Promise<void> {
  const authz = await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run');
  if (!authz) return;

  const credential = req.auth.credential;
  if (credential.type === 'external_integration') {
    const provenance = await repo.getRunRequestProvenance(run.id);
    if (
      provenance?.actorType !== 'external_integration'
      || provenance.externalIntegrationLinkId !== credential.linkId
      || provenance.externalIntegrationClientId !== credential.integrationId
    ) {
      res.status(403).json({
        error: {
          code: 'EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED',
          message: 'External integrations may decide approvals only for troubleshooting runs requested through the same linked integration',
          retryable: false
        }
      });
      return;
    }
  }

  const approval = await repo.getRunToolApproval(approvalId);
  if (!approval || approval.runId !== run.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
    return;
  }
  if (approval.status !== 'pending') {
    redispatchWaitingRunAfterApproval(run);
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

  const isRequesterRejecting = (
    req.body.decision === 'rejected'
    && (credential.type === 'external_integration' || approval.requestedBy === req.auth.userId)
  );
  if (!authz.can('create_read_write_runs') && !isRequesterRejecting) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Only workspace roles with read-write run capability can approve write actions',
        retryable: false
      }
    });
    return;
  }

  const outcome = await repo.decideRunToolApprovalOutcome(approval.id, req.body.decision, req.auth.userId);
  if (!outcome) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
    return;
  }
  const decided = outcome.approval;
  redispatchWaitingRunAfterApproval(run);
  if (!outcome.transitioned) {
    if (decided.decision === req.body.decision) {
      res.status(200).json(decided);
      return;
    }
    res.status(409).json({
      error: {
        code: decided.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_ALREADY_DECIDED',
        message: `Approval is already ${decided.status}`,
        retryable: false
      },
      approval: decided
    });
    return;
  }
  if (decided.status === 'expired') {
    await recordApprovalActivity(decided, 'approval.expired', run.sessionId, run.messageId);
    res.status(409).json({
      error: {
        code: 'APPROVAL_EXPIRED',
        message: 'Approval expired before the decision was recorded',
        retryable: false
      },
      approval: decided
    });
    return;
  }

  await recordApprovalActivity(decided, 'approval.decided', run.sessionId, run.messageId);
  webhooks.emit({
    type: 'run.tool_approval_decided.v1',
    workspaceId: run.workspaceId,
    clusterId: decided.targetType === KUBERNETES_TARGET_TYPE ? decided.targetId : undefined,
    targetId: decided.targetId,
    targetType: decided.targetType,
    subject: { type: 'tool_approval', id: decided.id },
    data: {
      runId: run.id,
      sessionId: run.sessionId,
      decision: decided.decision || decided.status,
      status: decided.status,
      decidedBy: req.auth.userId
    }
  });
  const auditActor = runAuditActor(req);
  await recordWorkspaceAuditEvent({
    workspaceId: run.workspaceId,
    category: 'approval',
    eventType: 'run.tool_approval_decided.v1',
    operation: 'write',
    ...auditActor,
    objectType: 'tool_approval',
    objectId: decided.id,
    objectName: decided.toolName,
    summary: 'Write-tool approval decided',
    metadata: {
      runId: run.id,
      sessionId: run.sessionId,
      decision: decided.decision || decided.status,
      status: decided.status,
      decisionActorType: auditActor.actorType || 'user',
      ...(credential.type === 'external_integration'
        ? {
            externalIntegrationClientId: credential.integrationId,
            externalIntegrationLinkId: credential.linkId
          }
        : {})
    }
  });
  res.status(200).json(decided);
}
