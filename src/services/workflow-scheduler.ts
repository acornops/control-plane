import { capabilitiesToPermissions, type WorkspaceCapability } from '../auth/authorization.js';
import { logger } from '../logger.js';
import { incrementWorkflowSchedulerEvent } from '../metrics.js';
import { isModelAllowedForProvider } from './llm-policy.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from './workflow-access.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import { recordWorkflowExecutionStarted } from './workflow-execution-events.js';
import { getWorkflowCapabilityReadinessErrors } from './workflow-readiness.js';
import { resolveWorkflowTarget } from './workflow-target-resolution.js';
import { validateWorkflowInputs } from './workflow-input-validation.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import { listAgentDefinitions } from '../store/repository-agents.js';
import { repo } from '../store/repository.js';
import {
  createWorkflowExecution,
  createWorkflowSession,
  getWorkflowDefinition,
  updateWorkflowRun
} from '../store/repository-workflows.js';
import {
  listDueWorkflowSchedules,
  recordWorkflowScheduleDispatch
} from '../store/repository-workflow-schedules.js';
import type { WorkflowDefinitionForAccess, WorkflowScheduleRecord } from '../types/workflows.js';

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

function requiredRunCapability(workflow: WorkflowDefinitionForAccess): WorkspaceCapability {
  return workflow.policy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

function workflowRuntimeSubject(schedule: WorkflowScheduleRecord, workflow: WorkflowDefinitionForAccess) {
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
  const workflow = await getWorkflowDefinition(schedule.workspaceId, schedule.workflowId);
  if (!workflow || workflow.status !== 'active') {
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Workflow is not active.' });
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
      agents: await listAgentDefinitions(schedule.workspaceId),
      actor: runtimeSubject,
      approvedContextGrants: schedule.approvedContextGrants
    });
  } catch (err) {
    if (err instanceof WorkflowAccessDeniedError) {
      await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: sanitizeError(err) });
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
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Workspace AI model is not allowed.' });
    incrementWorkflowSchedulerEvent('auto_paused');
    return 'auto_paused';
  }

  const step = workflow.steps[0];
  if (!step || step.agentIds?.length !== 1) throw new Error('Scheduled workflow step must select exactly one Agent');
  const agent = (await listAgentDefinitions(schedule.workspaceId, { includeInactive: true }))
    .find((candidate) => candidate.id === step.agentIds![0]);
  if (!agent || agent.status !== 'active') throw new Error('Scheduled workflow Agent is not active');
  await validateWorkflowInputs({ workspaceId: schedule.workspaceId, workflow, inputs: schedule.inputDefaults });
  const target = await resolveWorkflowTarget({
    workspaceId: schedule.workspaceId,
    workflow,
    inputs: schedule.inputDefaults
  });
  const readinessErrors = await getWorkflowCapabilityReadinessErrors(
    schedule.workspaceId,
    compiledAccessScope,
    target
  );
  if (readinessErrors.length > 0) {
    throw new Error(`Scheduled workflow capabilities are not ready: ${readinessErrors[0]}`);
  }
  const session = await createWorkflowSession({ workflow, createdBy: runtimeSubject.userId, compiledAccessScope });
  const occurrenceKey = schedule.nextRunAt || now.toISOString();
  const { execution, run } = await createWorkflowExecution({
    workflow,
    session,
    content: `Scheduled workflow: ${schedule.name}`,
    inputs: schedule.inputDefaults,
    triggerType: 'schedule',
    triggerId: schedule.id,
    occurrenceKey,
    targetId: target?.id,
    targetType: target?.targetType,
    agentSnapshot: agent as unknown as Record<string, unknown>,
    llmProvider: aiSettings.provider,
    llmModel: aiSettings.model,
    llmReasoningSummaryMode: aiSettings.reasoning.summary_mode,
    llmReasoningEffort: aiSettings.reasoning.effort
  });
  await recordWorkflowExecutionStarted(execution, run);
  if (run.status === 'waiting_for_approval') {
    await recordWorkflowScheduleDispatch(schedule.id, 'dispatched', { now });
    incrementWorkflowSchedulerEvent('approval_wait');
    return 'dispatched';
  }
  try {
    // The durable outbox worker owns dispatch and retries after this transaction.
    await recordWorkflowScheduleDispatch(schedule.id, 'dispatched', { now });
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
    await updateWorkflowRun(run.id, {
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
        const error = sanitizeError(err);
        await recordWorkflowScheduleDispatch(schedule.id, 'failed', { now, error });
        logger.error({ err, scheduleId: schedule.id }, 'Workflow scheduler failed processing due schedule');
        result.failed += 1;
      }
    }
    return result;
  })) || { claimed: 0, dispatched: 0, failed: 0, autoPaused: 0 };
}
