import { logger } from '../logger.js';
import { incrementWorkflowSchedulerEvent } from '../metrics.js';
import { isModelAllowedForProvider } from './llm-policy.js';
import { compileWorkflowAccessScope, WorkflowAccessDeniedError } from './workflow-access.js';
import { computeWorkflowReadiness } from './automation-readiness.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';
import { recordWorkspaceAuditEvent } from './workspace-audit.js';
import { resolveWorkflowTarget } from './workflow-target-resolution.js';
import { resolveWorkflowRepositoryScope, validateWorkflowInputs } from './workflow-input-validation.js';
import { withRedisLease } from './control-plane-coordination/leases.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
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
import { resolveRunPrincipal } from './run-principal.js';
import { getWorkflowCapabilityReadinessErrors } from './workflow-readiness.js';
import { resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';

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
  let entryAgent: NonNullable<Awaited<ReturnType<typeof getAgentDefinition>>>;
  const runtimeSubject = await resolveRunPrincipal(schedule.workspaceId, schedule.principal);
  if (!runtimeSubject) {
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Delegated principal is no longer authorized.' });
    incrementWorkflowSchedulerEvent('auto_paused');
    return 'auto_paused';
  }
  await validateWorkflowInputs({ workspaceId: schedule.workspaceId, workflow, inputs: schedule.inputDefaults });
  const target = await resolveWorkflowTarget({
    workspaceId: schedule.workspaceId,
    workflow,
    inputs: schedule.inputDefaults
  });
  try {
    const readiness = await computeWorkflowReadiness(workflow);
    if (readiness.status !== 'ready') {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
        readiness.reasons.slice(0, 4).join(' ') || 'Selected workflow Agents are not ready.'
      );
    }
    const resolvedEntryAgent = await getAgentDefinition(schedule.workspaceId, workflow.entryAgentId);
    if (!resolvedEntryAgent) {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_AGENT_SCOPE_DENIED',
        'Scheduled workflow coordination infrastructure is unavailable.'
      );
    }
    entryAgent = resolvedEntryAgent;
    const selectedAgents = (await Promise.all(workflow.agentIds.map((agentId) => (
      getAgentDefinition(schedule.workspaceId, agentId)
    )))).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    compiledAccessScope = compileWorkflowAccessScope({
      workflow,
      entryAgent,
      selectedAgents,
      mappings: await listCapabilityRoutingMappings(schedule.workspaceId, {
        activeReviewedOnly: true,
        capabilityIds: resolveEffectiveWorkflowCapabilityIds(workflow.capabilityPolicy, selectedAgents)
      }),
      actor: runtimeSubject,
      principal: schedule.principal,
      approvedContextGrants: schedule.approvedContextGrants,
      exactTargets: target ? [{ id: target.id, targetType: target.targetType }] : [],
      exactRepository: resolveWorkflowRepositoryScope(workflow, schedule.inputDefaults)
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

  const mcpReadinessErrors = await getWorkflowCapabilityReadinessErrors(
    schedule.workspaceId,
    compiledAccessScope,
    target,
    { principal: schedule.principal }
  );
  if (mcpReadinessErrors.length > 0) {
    const error = sanitizeError(new Error(mcpReadinessErrors[0]));
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error });
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
      metadata: {
        workflowId: schedule.workflowId,
        reason: 'mcp_readiness_failed',
        readinessCode: mcpReadinessErrors[0].startsWith('MCP_PAT_USER_PRINCIPAL_REQUIRED')
          ? 'MCP_PAT_USER_PRINCIPAL_REQUIRED'
          : 'MCP_PERSONAL_CONNECTION_REQUIRED'
      }
    });
    incrementWorkflowSchedulerEvent('auto_paused');
    incrementWorkflowSchedulerEvent('mcp_readiness_auto_paused');
    return 'auto_paused';
  }

  const aiSettings = await resolveWorkspaceLlmSettings(schedule.workspaceId);
  if (!isModelAllowedForProvider(aiSettings.provider, aiSettings.model)) {
    await recordWorkflowScheduleDispatch(schedule.id, 'auto_paused', { now, error: 'Workspace AI model is not allowed.' });
    incrementWorkflowSchedulerEvent('auto_paused');
    return 'auto_paused';
  }

  const session = await createWorkflowSession({ workflow, createdBy: runtimeSubject.userId, compiledAccessScope });
  const occurrenceKey = schedule.nextRunAt || now.toISOString();
  const { run } = await createWorkflowExecution({
    workflow,
    session,
    content: `Scheduled workflow: ${schedule.name}`,
    inputs: schedule.inputDefaults,
    triggerType: 'schedule',
    triggerId: schedule.id,
    occurrenceKey,
    targetId: target?.id,
    targetType: target?.targetType,
    agentSnapshot: entryAgent as unknown as Record<string, unknown>,
    llmProvider: aiSettings.provider,
    llmModel: aiSettings.model,
    llmReasoningSummaryMode: aiSettings.reasoning.summary_mode,
    llmReasoningEffort: aiSettings.reasoning.effort
  });
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
