import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { cancelRunInExecutionEngine } from '../services/execution-engine-client.js';
import { webhooks } from '../services/webhooks.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { recordWorkflowExecutionEvent } from '../services/workflow-execution-events.js';
import { repo } from '../store/repository.js';
import {
  appendWorkflowRunEvents,
  decideWorkflowRunApprovalOutcome,
  getWorkflowExecution,
  getWorkflowRunApproval,
  getWorkflowRun,
  listWorkflowRunApprovals,
  updateWorkflowRun
} from '../store/repository-workflows.js';
import { runtime } from '../store/runtime.js';
import { appendAgentRunEvents, getAgentActivityRecord, listAgentRunEvents, updateAgentActivityRecord } from '../store/repository-agents.js';
import { getAutomationRunApproval, listAutomationRunApprovals } from '../store/repository-automation-approvals.js';
import { KUBERNETES_TARGET_TYPE, RunEvent } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { decideAutomationApprovalRequest } from './automation-run-approval-decision.js';
import {
  dispatchWorkflowRunAfterApprovals,
  getReplayRunEvents,
  redispatchWaitingRunAfterApproval,
  writeSseRunEvent
} from './run-controller-helpers.js';
import { isRunTerminalStatus, terminalizeRunCancellation } from './run-cancellation.js';
import { decideTroubleshootingRunApproval } from './troubleshooting-run-approval-decision.js';
import { externalIntegrationOwnsWorkflowExecution } from './workflow-execution-access.js';
import { workflowAuditActor } from './workflow-external-access.js';
import {
  publicAgentRun,
  publicRunEvent,
  publicTroubleshootingRun,
  publicWorkflowRun
} from './external-run-public.js';
import { approvalForRequest, approvalsForRequest, isExternalIntegrationRequest } from './run-external-integration.js';
import { externalIntegrationOwnsTroubleshootingRun } from './run-external-integration.js';

export async function getRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      if (isExternalIntegrationRequest(req)) {
        const execution = await getWorkflowExecution(workflowRun.executionId);
        res.status(200).json(publicWorkflowRun(
          workflowRun,
          Boolean(execution && externalIntegrationOwnsWorkflowExecution(req, execution))
        ));
        return;
      }
      res.status(200).json(workflowRun);
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (!(await requireWorkspaceDataRead(req, res, agentRun.workspaceId, 'No access to run'))) return;
      res.status(200).json(isExternalIntegrationRequest(req) ? publicAgentRun(agentRun) : { ...agentRun, source: 'agent' });
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

    res.status(200).json(isExternalIntegrationRequest(req)
      ? publicTroubleshootingRun(run, await externalIntegrationOwnsTroubleshootingRun(req, run.id))
      : run);
  } catch (err) {
    next(err);
  }
}

export async function cancelRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
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
        await updateWorkflowRun(workflowRun.id, { status: 'cancelled', endedAt });
        const accepted = await appendWorkflowRunEvents(workflowRun.id, [
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
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      const authz = await requireWorkspaceDataRead(req, res, agentRun.workspaceId, 'No access to run');
      if (!authz) return;
      if (!authz.can('cancel_runs')) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No permission to cancel Agent runs', retryable: false } });
        return;
      }
      if (!isRunTerminalStatus(agentRun.status)) {
        const endedAt = new Date().toISOString();
        await updateAgentActivityRecord(runId, { status: 'cancelled', endedAt });
        await appendAgentRunEvents(agentRun, [{ schema_version: 1, run_id: runId,
          seq: (await listAgentRunEvents(runId)).length + 1, ts: endedAt, type: 'run_cancelled', payload: { reason: 'user_cancelled' } }]);
        await cancelRunInExecutionEngine(runId).catch(() => undefined);
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
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      const events = workflowRun.events || runtime.getRunEvents(workflowRun.id);
      res.status(200).json(isExternalIntegrationRequest(req) ? events.map(publicRunEvent) : events);
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (!(await requireWorkspaceDataRead(req, res, agentRun.workspaceId, 'No access to run'))) return;
      const events = await listAgentRunEvents(runId);
      res.status(200).json(isExternalIntegrationRequest(req) ? events.map(publicRunEvent) : events);
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
    res.status(200).json(isExternalIntegrationRequest(req) ? events.map(publicRunEvent) : events);
  } catch (err) {
    next(err);
  }
}

export async function listRunApprovals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      if (!(await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run'))) {
        return;
      }
      const [workflowApprovals, automationApprovals] = await Promise.all([
        listWorkflowRunApprovals(workflowRun.id),
        listAutomationRunApprovals('workflow', workflowRun.id)
      ]);
      const approvals = [...workflowApprovals, ...automationApprovals];
      res.status(200).json(approvalsForRequest(req, approvals));
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (!(await requireWorkspaceDataRead(req, res, agentRun.workspaceId, 'No access to run'))) return;
      const approvals = await listAutomationRunApprovals('agent', agentRun.id);
      res.status(200).json(approvalsForRequest(req, approvals));
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
    const approvals = await repo.listRunToolApprovals(run.id);
    res.status(200).json(approvalsForRequest(req, approvals));
  } catch (err) {
    next(err);
  }
}

export async function decideRunApproval(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const approvalId = toSingleParam(req.params.approvalId);
    const troubleshootingRun = await repo.getRun(runId);
    if (troubleshootingRun) {
      await decideTroubleshootingRunApproval(req, res, troubleshootingRun, approvalId);
      return;
    }
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      const authz = await requireWorkspaceDataRead(req, res, workflowRun.workspaceId, 'No access to run');
      if (!authz) {
        return;
      }
      if (req.auth.credential.type === 'external_integration') {
        const execution = await getWorkflowExecution(workflowRun.executionId);
        if (!execution || !externalIntegrationOwnsWorkflowExecution(req, execution)) {
          res.status(403).json({
            error: {
              code: 'EXTERNAL_INTEGRATION_APPROVAL_NOT_OWNED',
              message: 'External integrations may decide approvals only for Workflow executions requested through the same linked integration',
              retryable: false
            }
          });
          return;
        }
      }
      const approval = await getWorkflowRunApproval(approvalId);
      if (!approval || approval.runId !== workflowRun.id) {
        const automationApproval = await getAutomationRunApproval(approvalId);
        if (automationApproval?.sourceType === 'workflow' && automationApproval.runId === workflowRun.id) {
          await decideAutomationApprovalRequest(req, res, automationApproval);
          return;
        }
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      const isRequesterRejecting = req.body.decision === 'rejected' && approval.requestedBy === req.auth.userId;
      if (!authz.can('create_read_write_runs') && !isRequesterRejecting) {
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
          res.status(200).json(approvalForRequest(req, approval));
          return;
        }
        res.status(409).json({
          error: {
            code: approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_ALREADY_DECIDED',
            message: `Approval is already ${approval.status}`,
            retryable: false
          },
          approval: approvalForRequest(req, approval)
        });
        return;
      }

      const outcome = await decideWorkflowRunApprovalOutcome(approval.id, req.body.decision, req.auth.userId);
      if (!outcome) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      const decided = outcome.approval;
      if (!outcome.transitioned) {
        dispatchWorkflowRunAfterApprovals(workflowRun.id);
        if (decided.decision === req.body.decision) {
          res.status(200).json(approvalForRequest(req, decided));
          return;
        }
        res.status(409).json({
          error: {
            code: decided.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_ALREADY_DECIDED',
            message: `Approval is already ${decided.status}`,
            retryable: false
          },
          approval: approvalForRequest(req, decided)
        });
        return;
      }
      await recordWorkspaceAuditEvent({
        workspaceId: workflowRun.workspaceId,
        category: 'approval',
        eventType: 'workflow.approval_decided.v1',
        operation: 'write',
        ...workflowAuditActor(req),
        objectType: 'workflow_approval',
        objectId: decided.id,
        objectName: decided.toolName,
        summary: 'Workflow approval gate decided',
        metadata: {
          workflowId: workflowRun.workflowId,
          workflowRunId: workflowRun.workflowRunId,
          workflowSessionId: workflowRun.workflowSessionId,
          decision: decided.decision || decided.status,
          status: decided.status,
          decisionActorType: req.auth.credential.type,
          ...(req.auth.credential.type === 'external_integration'
            ? {
                externalIntegrationClientId: req.auth.credential.integrationId,
                externalIntegrationLinkId: req.auth.credential.linkId
              }
            : {})
        }
      });
      dispatchWorkflowRunAfterApprovals(workflowRun.id);
      await recordWorkflowExecutionEvent({
        executionId: workflowRun.executionId,
        workspaceId: workflowRun.workspaceId,
        type: 'approval_decided',
        runId: workflowRun.id,
        approvalId: decided.id,
        dedupeKey: `approval-decided:${decided.id}:${decided.status}`,
        payload: {
          approvalKind: 'pre_step',
          status: decided.status,
          decision: decided.decision || null
        }
      });
      if (decided.status === 'expired') {
        res.status(409).json({
          error: {
            code: 'APPROVAL_EXPIRED',
            message: 'Approval expired before the decision was recorded',
            retryable: false
          },
          approval: approvalForRequest(req, decided)
        });
        return;
      }
      res.status(200).json(approvalForRequest(req, decided));
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      if (req.auth.credential.type === 'external_integration') {
        res.status(403).json({
          error: {
            code: 'EXTERNAL_INTEGRATION_AGENT_APPROVAL_FORBIDDEN',
            message: 'External integrations cannot decide standalone Agent approvals',
            retryable: false
          }
        });
        return;
      }
      const approval = await getAutomationRunApproval(approvalId);
      if (!approval || approval.sourceType !== 'agent' || approval.runId !== agentRun.id) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approval not found', retryable: false } });
        return;
      }
      await decideAutomationApprovalRequest(req, res, approval);
      return;
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
  } catch (err) {
    next(err);
  }
}

export async function streamRun(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    const run = workflowRun || await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    if (!(await requireWorkspaceDataRead(req, res, run.workspaceId, 'No access to run'))) {
      return;
    }
    const publicExternalStream = isExternalIntegrationRequest(req);

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
      if (typeof runEvent.seq === 'number') {
        lastReplayedSeq = runEvent.seq;
      }
      writeSseRunEvent(res, publicExternalStream ? publicRunEvent(runEvent) : runEvent);
    };

    runtime.runStreams.on(`run:${run.id}`, listener);

    try {
      const replayExistingEvents = (existing: RunEvent[]) => {
        for (const event of existing) {
          lastReplayedSeq = Math.max(lastReplayedSeq, event.seq);
          writeSseRunEvent(res, publicExternalStream ? publicRunEvent(event) : event);
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
        if (typeof event.seq === 'number') {
          lastReplayedSeq = event.seq;
        }
        writeSseRunEvent(res, publicExternalStream ? publicRunEvent(event) : event);
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
