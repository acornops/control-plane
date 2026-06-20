import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { recordApprovalActivity, recordRunStatusChangedActivity } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';

export async function createToolApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (run.toolAccessMode !== 'read_write') {
      res.status(400).json({ error: { code: 'READ_WRITE_REQUIRED', message: 'Run is not allowed to execute write tools', retryable: false } });
      return;
    }
    const session = await repo.getSession(run.sessionId, true);
    const expiresAt = new Date(Date.now() + config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString();
    const approval = await repo.createRunToolApproval({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId: run.targetId,
      toolCallId: req.body.toolCallId,
      toolName: req.body.toolName,
      summary: req.body.summary,
      arguments: req.body.arguments || {},
      requestedBy: session?.createdBy,
      sessionId: run.sessionId,
      expiresAt,
      continuationState: req.body.continuation
    });
    const waitingRun = await repo.getRun(run.id);
    await recordRunStatusChangedActivity(run, waitingRun);
    await recordApprovalActivity(approval, 'approval.requested', run.sessionId, run.messageId);
    webhooks.emit({
      type: 'run.tool_approval_requested.v1',
      workspaceId: run.workspaceId,
      clusterId: approval.targetType === KUBERNETES_TARGET_TYPE ? approval.targetId : undefined,
      targetId: approval.targetId,
      targetType: approval.targetType,
      subject: { type: 'tool_approval', id: approval.id },
      data: {
        runId: run.id,
        sessionId: run.sessionId,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        summary: approval.summary,
        arguments: approval.arguments,
        expiresAt: approval.expiresAt
      }
    });
    res.status(201).json(approval);
  } catch (err) {
    next(err);
  }
}

export async function getRunContinuation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const continuation = await repo.getRunContinuation(runId);
    if (!continuation) {
      res.status(200).json(null);
      return;
    }
    const approval = await repo.getRunToolApproval(continuation.approvalId);
    if (!approval) {
      res.status(404).json({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    let effectiveApproval = approval;
    if (approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= Date.now()) {
      effectiveApproval = (await repo.expireRunToolApproval(approval.id)) || approval;
      if (effectiveApproval.status === 'expired') {
        const run = await repo.getRun(effectiveApproval.runId);
        if (run) {
          await recordApprovalActivity(effectiveApproval, 'approval.expired', run.sessionId, run.messageId);
        }
      }
    }
    res.status(200).json({ ...continuation, approval: effectiveApproval });
  } catch (err) {
    next(err);
  }
}

export async function markToolApprovalExecutionStarted(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const approval = await repo.getRunToolApproval(approvalId);
    if (!approval || approval.runId !== runId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    const updated = await repo.markRunToolApprovalExecutionStarted(approval.id);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function markToolApprovalExecutionFinished(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const approval = await repo.getRunToolApproval(approvalId);
    if (!approval || approval.runId !== runId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    const updated = await repo.markRunToolApprovalExecutionFinished(
      approval.id,
      req.body.result,
      Boolean(req.body.isError)
    );
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

export async function consumeRunContinuation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    await repo.deleteRunContinuation(runId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
