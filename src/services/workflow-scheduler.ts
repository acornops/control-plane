import { capabilitiesToPermissions, type WorkspaceCapability } from '../auth/authorization.js';
import { logger } from '../logger.js';
import { incrementWorkflowSchedulerEvent } from '../metrics.js';
import { dispatchWorkflowRunToExecutionEngine } from './execution-engine-client.js';
import { isModelAllowedForProvider } from './llm-policy.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from './workflow-access.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import { listAgentDefinitions } from '../store/repository-agents.js';
import { repo } from '../store/repository.js';
import {
  createWorkflowRun,
  createWorkflowSession,
  createWorkflowUserMessage,
  getWorkflowDefinition,
  updateWorkflowRun
} from '../store/repository-workflows.js';
import {
  listDueWorkflowSchedules,
  recordWorkflowScheduleDispatch
} from '../store/repository-workflow-schedules.js';
import type { WorkflowScheduleRecord } from '../types/workflows.js';

export interface WorkflowScheduleTickResult {
  claimed: number;
  dispatched: number;
  failed: number;
  autoPaused: number;
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Unknown schedule dispatch failure';
  return message.slice(0, 240);
}

function requiredRunCapability(workflow: NonNullable<ReturnType<typeof getWorkflowDefinition>>): WorkspaceCapability {
  return workflow.policy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

function workflowRuntimeSubject(schedule: WorkflowScheduleRecord, workflow: NonNullable<ReturnType<typeof getWorkflowDefinition>>) {
  const permissions = capabilitiesToPermissions([
    ...workflow.requiredPermissions,
    requiredRunCapability(workflow)
  ]);
  return {
    userId: `workflow-schedule:${schedule.id}`,
    role: 'workflow_runtime',
    permissions
  };
}

async function dispatchSchedule(schedule: WorkflowScheduleRecord, now: Date): Promise<'dispatched' | 'failed' | 'auto_paused'> {
  const workflow = getWorkflowDefinition(schedule.workspaceId, schedule.workflowId);
  if (!workflow || workflow.status !== 'active') {
    recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Workflow is not active.' });
    await recordWorkspaceAuditEvent({
      workspaceId: schedule.workspaceId,
      category: 'run',
      eventType: 'workflow.schedule_auto_paused.v1',
      operation: 'write',
      actorUserId: schedule.updatedBy.userId,
      objectType: 'workflow_schedule',
      objectId: schedule.id,
      objectName: schedule.name,
      summary: 'Workflow schedule auto-paused',
      metadata: { workflowId: schedule.workflowId, reason: 'workflow_not_active' }
    });
    incrementWorkflowSchedulerEvent('auto_paused');
    return 'auto_paused';
  }

  let compiledAccessScope;
  const runtimeSubject = workflowRuntimeSubject(schedule, workflow);
  try {
    compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      agents: listAgentDefinitions(schedule.workspaceId),
      actor: runtimeSubject,
      approvedContextGrants: schedule.approvedContextGrants
    });
  } catch (err) {
    if (err instanceof WorkflowAccessDeniedError) {
      recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: sanitizeError(err) });
      await recordWorkspaceAuditEvent({
        workspaceId: schedule.workspaceId,
        category: 'run',
        eventType: 'workflow.schedule_auto_paused.v1',
        operation: 'write',
        actorUserId: schedule.createdBy.userId,
        objectType: 'workflow_schedule',
        objectId: schedule.id,
        objectName: schedule.name,
        summary: 'Workflow schedule auto-paused',
        metadata: { workflowId: schedule.workflowId, reason: 'access_denied' }
      });
      incrementWorkflowSchedulerEvent('auto_paused');
      return 'auto_paused';
    }
    throw err;
  }

  const aiSettings = await resolveWorkspaceLlmSettings(schedule.workspaceId);
  if (!isModelAllowedForProvider(aiSettings.provider, aiSettings.model)) {
    recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Workspace AI model is not allowed.' });
    incrementWorkflowSchedulerEvent('auto_paused');
    return 'auto_paused';
  }

  const session = createWorkflowSession({ workflow, createdBy: runtimeSubject.userId, compiledAccessScope });
  const message = createWorkflowUserMessage({
    session,
    content: `Scheduled workflow: ${schedule.name}`,
    inputs: schedule.inputDefaults
  });
  const stepId = workflow.steps[0]?.id;
  const run = createWorkflowRun({
    session,
    message,
    workflowStepId: stepId,
    llmProvider: aiSettings.provider,
    llmModel: aiSettings.model,
    llmReasoningSummaryMode: aiSettings.reasoning.summary_mode,
    llmReasoningEffort: aiSettings.reasoning.effort
  });
  if (run.status === 'waiting_for_approval') {
    recordWorkflowScheduleDispatch(schedule.id, 'dispatched', { now });
    incrementWorkflowSchedulerEvent('approval_wait');
    return 'dispatched';
  }
  try {
    updateWorkflowRun(run.id, { status: 'dispatching' });
    await dispatchWorkflowRunToExecutionEngine(run);
    updateWorkflowRun(run.id, { status: 'running', startedAt: now.toISOString() });
    recordWorkflowScheduleDispatch(schedule.id, 'dispatched', { now });
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
        workflowRunId: run.workflowRunId,
        runId: run.id,
        scheduleId: schedule.id,
        createdBy: schedule.createdBy.userId,
        runtimeSubject: {
          type: 'workflow_schedule',
          userId: runtimeSubject.userId,
          role: runtimeSubject.role
        },
        dispatchReason: 'scheduled_due'
      }
    });
    incrementWorkflowSchedulerEvent('dispatched');
    return 'dispatched';
  } catch (err) {
    const error = sanitizeError(err);
    updateWorkflowRun(run.id, {
      status: 'failed',
      errorCode: 'SCHEDULE_DISPATCH_FAILED',
      errorMessage: error,
      endedAt: now.toISOString()
    });
    recordWorkflowScheduleDispatch(schedule.id, 'failed', { now, error });
    logger.error({ err, scheduleId: schedule.id, workflowId: schedule.workflowId }, 'Workflow schedule dispatch failed');
    incrementWorkflowSchedulerEvent('dispatch_failed');
    return 'failed';
  }
}

export async function runWorkflowScheduleTick(params: { now?: Date; limit?: number } = {}): Promise<WorkflowScheduleTickResult> {
  const now = params.now || new Date();
  return (await withRedisLease('workflow-scheduler', 30, async () => {
    const due = listDueWorkflowSchedules(now, params.limit || 50);
    const result: WorkflowScheduleTickResult = { claimed: due.length, dispatched: 0, failed: 0, autoPaused: 0 };
    incrementWorkflowSchedulerEvent('tick');
    for (const schedule of due) {
      try {
        const outcome = await dispatchSchedule(schedule, now);
        if (outcome === 'auto_paused') result.autoPaused += 1;
        else if (outcome === 'failed') result.failed += 1;
        else result.dispatched += 1;
      } catch (err) {
        const error = sanitizeError(err);
        recordWorkflowScheduleDispatch(schedule.id, 'failed', { now, error });
        logger.error({ err, scheduleId: schedule.id }, 'Workflow scheduler failed processing due schedule');
        result.failed += 1;
      }
    }
    return result;
  })) || { claimed: 0, dispatched: 0, failed: 0, autoPaused: 0 };
}
