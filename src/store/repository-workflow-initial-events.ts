import type { PoolClient } from 'pg';
import {
  insertWorkflowExecutionEvent,
  type WorkflowExecutionStreamEvent
} from './repository-workflow-execution-events.js';

interface InitialWorkflowEventInput {
  execution: {
    id: string;
    workspaceId: string;
    workflowId: string;
    workflowSessionId: string;
    workflowVersion: number;
    status: string;
    triggerType: string;
  };
  run: {
    id: string;
    agentId?: string;
    attemptNumber: number;
    status: string;
    targetId?: string;
    targetType?: string;
  };
  approvals: Array<{
    id: string;
    toolName: string;
    summary: string;
    status: string;
    expiresAt: string;
  }>;
}

export async function insertInitialWorkflowExecutionEvents(
  client: PoolClient,
  input: InitialWorkflowEventInput
): Promise<WorkflowExecutionStreamEvent[]> {
  const { execution, run } = input;
  const events: WorkflowExecutionStreamEvent[] = [];
  const executionCreated = await insertWorkflowExecutionEvent(client, {
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
  if (executionCreated) events.push(executionCreated);
  const runCreated = await insertWorkflowExecutionEvent(client, {
    executionId: execution.id,
    workspaceId: execution.workspaceId,
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
  if (runCreated) events.push(runCreated);
  for (const approval of input.approvals) {
    const requested = await insertWorkflowExecutionEvent(client, {
      executionId: execution.id,
      workspaceId: execution.workspaceId,
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
    if (requested) events.push(requested);
  }
  return events;
}
