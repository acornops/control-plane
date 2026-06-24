import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { config } from '../config.js';
import { cancelRunInExecutionEngine, dispatchRunToExecutionEngine, dispatchWorkflowRunToExecutionEngine } from '../services/execution-engine-client.js';
import { recordApprovalActivity } from '../services/target-chat-activity-events.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { logger } from '../logger.js';
import { repo } from '../store/repository.js';
import {
  appendWorkflowRunEvents,
  decideWorkflowRunApproval,
  getWorkflowRunApproval,
  getWorkflowRun,
  listWorkflowRunApprovals,
  updateWorkflowRun
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { KUBERNETES_TARGET_TYPE, Run, RunEvent } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { isRunTerminalStatus, terminalizeRunCancellation } from './run-cancellation.js';

async function getReplayRunEvents(runId: string): Promise<RunEvent[]> {
  if (config.PERSIST_RUN_EVENTS) {
    return repo.getRunEvents(runId);
  }
  return runtime.getRunEvents(runId) as RunEvent[];
}

function writeSseRunEvent(res: Response, event: RunEvent): void {
  const eventType = typeof event.type === 'string' ? event.type : undefined;
  if (eventType) {
    res.write(`event: ${eventType}\n`);
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function redispatchWaitingRunAfterApproval(run: Run): void {
  if (run.status !== 'waiting_for_approval') return;
  queueMicrotask(async () => {
    try {
      const latest = await repo.getRun(run.id);
      if (!latest || latest.status !== 'waiting_for_approval') return;
      const current = (await repo.updateRun(run.id, { status: 'dispatching' })) || latest;
      await dispatchRunToExecutionEngine({ ...current, status: 'dispatching' });
    } catch (err) {
      logger.error({ err, runId: run.id }, 'Failed redispatching run after approval decision');
    }
  });
}

function dispatchWorkflowRunAfterApprovals(runId: string): void {
  queueMicrotask(async () => {
    const run = getWorkflowRun(runId);
    if (!run || run.status !== 'waiting_for_approval') return;
    const approvals = listWorkflowRunApprovals(run.id);
    if (approvals.some((approval) => approval.status === 'pending')) return;
    if (approvals.some((approval) => approval.status === 'rejected' || approval.status === 'expired')) {
      updateWorkflowRun(run.id, {
        status: 'failed',
        errorCode: 'WORKFLOW_APPROVAL_NOT_GRANTED',
        errorMessage: 'Workflow approval gate was not granted.',
        endedAt: new Date().toISOString()
      });
      return;
    }
    const dispatching = updateWorkflowRun(run.id, { status: 'dispatching' }) || run;
    try {
      await dispatchWorkflowRunToExecutionEngine(dispatching);
      updateWorkflowRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    } catch (err) {
      updateWorkflowRun(run.id, {
        status: 'failed',
        errorCode: 'DISPATCH_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Unknown dispatch failure',
        endedAt: new Date().toISOString()
      });
    }
  });
}

export async function getRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      res.status(200).json(workflowRun);
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run'))) {
      return;
    }

    res.status(200).json(run);
  } catch (err) {
    next(err);
  }
}

export async function cancelRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      const authz = await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run');
      if (!authz) {
        return;
      }
      if (!authz.can('cancel_runs')) {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Only workspace roles with run cancellation capability can cancel workflow runs',
            retryable: false
          }
        });
        return;
      }
      if (!isRunTerminalStatus(workflowRun.status)) {
        const endedAt = new Date().toISOString();
        updateWorkflowRun(workflowRun.id, { status: 'cancelled', endedAt });
        const accepted = appendWorkflowRunEvents(workflowRun.id, [
          {
            schema_version: 1,
            run_id: workflowRun.id,
            seq: (workflowRun.events?.length || 0) + 1,
            ts: endedAt,
            type: 'run_cancelled',
            payload: { reason: 'user_cancelled' }
          }
        ]);
        for (const event of runtime.appendRunEvents(workflowRun.id, accepted)) {
          runtime.runStreams.emit(`run:${workflowRun.id}`, { event });
        }
        await recordWorkspaceAuditEvent({
          workspaceId: workflowRun.workspaceId,
          category: 'run',
          eventType: 'workflow.run_cancel_requested.v1',
          operation: 'write',
          actorUserId: req.auth.userId,
          objectType: 'workflow_run',
          objectId: workflowRun.id,
          objectName: workflowRun.workflowId,
          summary: 'Workflow run cancellation requested',
          metadata: {
            workflowId: workflowRun.workflowId,
            workflowRunId: workflowRun.workflowRunId,
            workflowSessionId: workflowRun.workflowSessionId,
            previousStatus: workflowRun.status
          }
        });
        await cancelRunInExecutionEngine(workflowRun.id).catch(() => undefined);
      }
      res.status(202).json({ status: 'accepted' });
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(202).json({ status: 'accepted' });
      return;
    }

    const authz = await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run');
    if (!authz) {
      return;
    }
    if (!authz.can('cancel_runs')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only workspace roles with run cancellation capability can cancel troubleshooting runs',
          retryable: false
        }
      });
      return;
    }

    webhooks.emit({
      type: 'run.cancel_requested.v1',
      workspaceId: run.workspaceId,
      clusterId: run.targetType === KUBERNETES_TARGET_TYPE ? run.targetId : undefined,
      targetId: run.targetId,
      targetType: run.targetType,
      subject: { type: 'run', id: run.id },
      data: {
        sessionId: run.sessionId,
        messageId: run.messageId,
        previousStatus: run.status,
        requestedBy: req.auth.userId
      }
    });
    await recordWorkspaceAuditEvent({
      workspaceId: run.workspaceId,
      category: 'run',
      eventType: 'run.cancel_requested.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'run',
      objectId: run.id,
      summary: 'Troubleshooting run cancellation requested',
      metadata: {
        sessionId: run.sessionId,
        previousStatus: run.status
      }
    });

    const shouldNotifyExecutionEngine = !isRunTerminalStatus(run.status) && run.status !== 'waiting_for_approval';
    await terminalizeRunCancellation(run);
    if (shouldNotifyExecutionEngine) {
      await cancelRunInExecutionEngine(run.id).catch(() => undefined);
    }

    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    next(err);
  }
}

export async function listRunEvents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      res.status(200).json(workflowRun.events || runtime.getRunEvents(workflowRun.id));
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run'))) {
      return;
    }

    const events = await getReplayRunEvents(run.id);
    res.status(200).json(events);
  } catch (err) {
    next(err);
  }
}

export async function listRunApprovals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      res.status(200).json(listWorkflowRunApprovals(workflowRun.id));
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (!(await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run'))) {
      return;
    }
    res.status(200).json(await repo.listRunToolApprovals(run.id));
  } catch (err) {
    next(err);
  }
}

export async function decideRunApproval(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      const authz = await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run');
      if (!authz) {
        return;
      }
      const approval = getWorkflowRunApproval(approvalId);
      if (!approval || approval.runId !== workflowRun.id) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      if (!authz.can('create_read_write_runs')) {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Only workspace roles with read-write run capability can decide workflow approval gates',
            retryable: false
          }
        });
        return;
      }
      if (approval.status !== 'pending') {
        if (approval.decision === req.body.decision) {
          res.status(200).json(approval);
          return;
        }
        res.status(409).json({
          error: {
            code: 'APPROVAL_ALREADY_DECIDED',
            message: `Approval is already ${approval.status}`,
            retryable: false
          },
          approval
        });
        return;
      }

      const decided = decideWorkflowRunApproval(approval.id, req.body.decision, req.auth.userId);
      if (!decided) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      await recordWorkspaceAuditEvent({
        workspaceId: workflowRun.workspaceId,
        category: 'approval',
        eventType: 'workflow.approval_decided.v1',
        operation: 'write',
        actorUserId: req.auth.userId,
        objectType: 'workflow_approval',
        objectId: decided.id,
        objectName: decided.toolName,
        summary: 'Workflow approval gate decided',
        metadata: {
          workflowId: workflowRun.workflowId,
          workflowRunId: workflowRun.workflowRunId,
          workflowSessionId: workflowRun.workflowSessionId,
          workflowStepId: workflowRun.workflowStepId || null,
          decision: decided.decision || decided.status,
          status: decided.status
        }
      });
      dispatchWorkflowRunAfterApprovals(workflowRun.id);
      res.status(200).json(decided);
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const authz = await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run');
    if (!authz) {
      return;
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
          code: 'APPROVAL_ALREADY_DECIDED',
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
          message: 'Only workspace roles with read-write run capability can approve write actions',
          retryable: false
        }
      });
      return;
    }

    const decided = await repo.decideRunToolApproval(approval.id, req.body.decision, req.auth.userId);
    if (!decided) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
      return;
    }
    redispatchWaitingRunAfterApproval(run);
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
    await recordWorkspaceAuditEvent({
      workspaceId: run.workspaceId,
      category: 'approval',
      eventType: 'run.tool_approval_decided.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'tool_approval',
      objectId: decided.id,
      objectName: decided.toolName,
      summary: 'Write-tool approval decided',
      metadata: {
        runId: run.id,
        sessionId: run.sessionId,
        decision: decided.decision || decided.status,
        status: decided.status
      }
    });
    res.status(200).json(decided);
  } catch (err) {
    next(err);
  }
}

export async function streamRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = getWorkflowRun(runId);
    const run = workflowRun || await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run'))) {
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const bufferedLiveEvents: RunEvent[] = [];
    let replaying = true;
    let lastReplayedSeq = 0;

    const listener = ({ event }: { event: unknown }) => {
      const runEvent = event as RunEvent;
      if (replaying) {
        bufferedLiveEvents.push(runEvent);
        return;
      }
      if (typeof runEvent.seq === 'number' && runEvent.seq <= lastReplayedSeq) {
        return;
      }
      writeSseRunEvent(res, runEvent);
    };

    runtime.runStreams.on(`run:${run.id}`, listener);

    try {
      const replayExistingEvents = (existing: RunEvent[]) => {
        for (const event of existing) {
          lastReplayedSeq = Math.max(lastReplayedSeq, event.seq);
          writeSseRunEvent(res, event);
        }
      };
      if (workflowRun) {
        replayExistingEvents((workflowRun.events || runtime.getRunEvents(workflowRun.id)) as RunEvent[]);
      } else {
        const existing = await getReplayRunEvents(run.id);
        replayExistingEvents(existing);
      }

      replaying = false;
      for (const event of bufferedLiveEvents) {
        if (typeof event.seq === 'number' && event.seq <= lastReplayedSeq) {
          continue;
        }
        writeSseRunEvent(res, event);
      }
    } catch (err) {
      runtime.runStreams.off(`run:${run.id}`, listener);
      throw err;
    }

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      runtime.runStreams.off(`run:${run.id}`, listener);
    });
  } catch (err) {
    next(err);
  }
}
