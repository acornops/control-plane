import { logger } from '../logger.js';
import { publishWorkflowExecutionEvents } from './control-plane-coordination.js';
import {
  appendWorkflowExecutionEvent,
  type InsertWorkflowExecutionEventInput,
  type WorkflowExecutionStreamEvent
} from '../store/repository-workflow-execution-events.js';
import { runtime } from '../store/runtime.js';
import type { RunEvent } from '../types/domain.js';
import {
  getWorkflowRun,
  listWorkflowRunApprovals,
  type WorkflowExecutionRecord,
  type WorkflowRunRecord
} from '../store/repository-workflows.js';

export function emitWorkflowExecutionEvents(
  executionId: string,
  events: WorkflowExecutionStreamEvent[]
): void {
  for (const event of events) {
    runtime.workflowExecutionStreams.emit(`workflow-execution:${executionId}`, { event });
  }
  publishWorkflowExecutionEvents(executionId, events).catch((err) => {
    logger.warn({ err, executionId }, 'Failed publishing distributed Workflow execution events');
  });
}

export async function recordWorkflowExecutionEvent(
  input: InsertWorkflowExecutionEventInput
): Promise<WorkflowExecutionStreamEvent | null> {
  const event = await appendWorkflowExecutionEvent(input);
  if (event) emitWorkflowExecutionEvents(input.executionId, [event]);
  return event;
}

export async function recordWorkflowRunEvents(params: {
  executionId: string;
  workspaceId: string;
  runId: string;
  events: RunEvent[];
}): Promise<void> {
  const recorded: WorkflowExecutionStreamEvent[] = [];
  for (const runEvent of params.events) {
    const event = await appendWorkflowExecutionEvent({
      executionId: params.executionId,
      workspaceId: params.workspaceId,
      type: 'run_event',
      runId: params.runId,
      runEventSeq: runEvent.seq,
      dedupeKey: `run-event:${params.runId}:${runEvent.seq}`,
      occurredAt: runEvent.ts
    });
    if (event) recorded.push(event);
  }
  emitWorkflowExecutionEvents(params.executionId, recorded);
}

export async function recordWorkflowExecutionStarted(
  execution: WorkflowExecutionRecord,
  run: WorkflowRunRecord
): Promise<void> {
  await recordWorkflowExecutionEvent({
    executionId: execution.id,
    workspaceId: execution.workspaceId,
    type: 'execution_created',
    dedupeKey: 'execution-created',
    payload: {
      workflowId: execution.workflowId,
      workflowSessionId: execution.workflowSessionId,
      workflowVersion: execution.workflowVersion,
      status: execution.status,
      triggerType: execution.triggerType
    }
  });
  await recordWorkflowRunStarted(run);
}

async function recordWorkflowRunStarted(run: WorkflowRunRecord): Promise<void> {
  await recordWorkflowExecutionEvent({
    executionId: run.executionId,
    workspaceId: run.workspaceId,
    type: 'run_created',
    runId: run.id,
    dedupeKey: `run-created:${run.id}`,
    payload: {
      agentId: run.agentId || null,
      attemptNumber: run.attemptNumber,
      status: run.status,
      targetId: run.targetId || null,
      targetType: run.targetType || null
    }
  });
  for (const approval of await listWorkflowRunApprovals(run.id)) {
    await recordWorkflowExecutionEvent({
      executionId: run.executionId,
      workspaceId: run.workspaceId,
      type: 'approval_requested',
      runId: run.id,
      approvalId: approval.id,
      dedupeKey: `approval-requested:${approval.id}`,
      payload: {
        approvalKind: 'pre_step',
        toolName: approval.toolName,
        summary: approval.summary,
        status: approval.status,
        expiresAt: approval.expiresAt
      }
    });
  }
}

export async function recordWorkflowExecutionTransition(
  run: WorkflowRunRecord,
  transition: { executionStatus: string; nextRunId?: string }
): Promise<void> {
  if (transition.nextRunId) {
    const nextRun = await getWorkflowRun(transition.nextRunId);
    if (nextRun) await recordWorkflowRunStarted(nextRun);
  }
  await recordWorkflowExecutionEvent({
    executionId: run.executionId,
    workspaceId: run.workspaceId,
    type: 'execution_status_changed',
    runId: run.id,
    dedupeKey: `execution-status:${transition.executionStatus}:${transition.nextRunId || run.id}`,
    payload: { status: transition.executionStatus, nextRunId: transition.nextRunId || null }
  });
}
