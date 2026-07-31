import { logger } from '../logger.js';
import { incrementWorkflowSchedulerEvent } from '../metrics.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import {
  listDueWorkflowSchedules,
  recordWorkflowScheduleDispatch
} from '../store/repository-workflow-schedules.js';
import { updateWorkflowRun } from '../store/repository-workflows.js';
import type { WorkflowScheduleRecord } from '../types/workflows.js';
import {
  dispatchWorkflowTrigger,
  sanitizeWorkflowTriggerError
} from './workflow-trigger-dispatch.js';

export interface WorkflowScheduleTickResult {
  claimed: number;
  dispatched: number;
  failed: number;
  autoPaused: number;
}

async function dispatchSchedule(schedule: WorkflowScheduleRecord, now: Date): Promise<'dispatched' | 'failed' | 'auto_paused'> {
  const occurrenceKey = schedule.nextRunAt || now.toISOString();
  const dispatch = await dispatchWorkflowTrigger({
    id: schedule.id,
    name: schedule.name,
    workspaceId: schedule.workspaceId,
    workflowId: schedule.workflowId,
    approvedContextGrants: schedule.approvedContextGrants,
    principal: schedule.principal,
    triggerType: 'schedule',
    occurrenceKey
  });
  if (dispatch.outcome === 'auto_paused') {
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: dispatch.error });
    await recordWorkspaceAuditEvent({
      workspaceId: schedule.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_auto_paused.v1',
      operation: 'write',
      actorUserId: dispatch.reason === 'workflow_not_active'
        || dispatch.reason === 'workflow_definition_invalid'
        ? schedule.updatedBy.userId
        : schedule.createdBy.userId,
      objectType: 'workflow_schedule',
      objectId: schedule.id,
      objectName: schedule.name,
      summary: 'Workflow schedule auto-paused',
      metadata: {
        workflowId: schedule.workflowId,
        reason: dispatch.reason,
        ...(dispatch.reason === 'mcp_readiness_failed' ? {
          readinessCode: dispatch.error.startsWith('MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED')
            ? 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
            : 'MCP_CONNECTION_REQUIRED'
        } : {})
      }
    });
    incrementWorkflowSchedulerEvent('auto_paused');
    if (dispatch.reason === 'mcp_readiness_failed') {
      incrementWorkflowSchedulerEvent('mcp_readiness_auto_paused');
    }
    return 'auto_paused';
  }

  try {
    await recordWorkflowScheduleDispatch(schedule.id, 'dispatched', {
      now,
      executionId: dispatch.executionId,
      runId: dispatch.runId
    });
    if (dispatch.waitingForApproval) {
      incrementWorkflowSchedulerEvent('approval_wait');
      return 'dispatched';
    }
    await recordWorkspaceAuditEvent({
      workspaceId: schedule.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_dispatched.v1',
      operation: 'write',
      actorUserId: schedule.createdBy.userId,
      objectType: 'workflow_schedule',
      objectId: schedule.id,
      objectName: schedule.name,
      summary: 'Workflow schedule dispatched',
      metadata: {
        workflowId: schedule.workflowId,
        executionId: dispatch.executionId,
        runId: dispatch.runId,
        scheduleId: schedule.id,
        createdBy: schedule.createdBy.userId,
        runtimeSubject: {
          type: 'workflow_schedule',
          userId: dispatch.runtimeSubject.userId,
          role: dispatch.runtimeSubject.role
        },
        dispatchReason: 'scheduled_due'
      }
    });
    incrementWorkflowSchedulerEvent('dispatched');
    return 'dispatched';
  } catch (err) {
    const error = sanitizeWorkflowTriggerError(err);
    await updateWorkflowRun(dispatch.runId, {
      status: 'failed',
      errorCode: 'SCHEDULE_DISPATCH_FAILED',
      errorMessage: error,
      endedAt: now.toISOString()
    });
    await recordWorkflowScheduleDispatch(schedule.id, 'failed', { now, error });
    logger.error({ err, scheduleId: schedule.id, workflowId: schedule.workflowId }, 'Workflow schedule dispatch failed');
    incrementWorkflowSchedulerEvent('dispatch_failed');
    return 'failed';
  }
}

export async function runWorkflowScheduleTick(params: { now?: Date; limit?: number } = {}): Promise<WorkflowScheduleTickResult> {
  const now = params.now || new Date();
  return (await withRedisLease('workflow-scheduler', 30, async () => {
    const due = await listDueWorkflowSchedules(now, params.limit || 50);
    const result: WorkflowScheduleTickResult = { claimed: due.length, dispatched: 0, failed: 0, autoPaused: 0 };
    incrementWorkflowSchedulerEvent('tick');
    for (const schedule of due) {
      try {
        const outcome = await dispatchSchedule(schedule, now);
        if (outcome === 'auto_paused') result.autoPaused += 1;
        else if (outcome === 'failed') result.failed += 1;
        else result.dispatched += 1;
      } catch (err) {
        const error = sanitizeWorkflowTriggerError(err);
        await recordWorkflowScheduleDispatch(schedule.id, 'failed', { now, error });
        logger.error({ err, scheduleId: schedule.id }, 'Workflow scheduler failed processing due schedule');
        result.failed += 1;
      }
    }
    return result;
  })) || { claimed: 0, dispatched: 0, failed: 0, autoPaused: 0 };
}
