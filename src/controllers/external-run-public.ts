import type { Run, RunEvent, RunToolApproval } from '../types/domain.js';
import type { AutomationRunApproval } from '../store/repository-automation-approvals.js';
import type { WorkflowExecutionStreamEvent } from '../store/repository-workflow-execution-events.js';
import type { WorkflowApprovalRecord } from '../store/repository-workflow-run-approvals.js';
import type { WorkflowRunRecord } from '../store/repository-workflow-runs.js';

const APPROVAL_PAYLOAD_FIELDS = new Set([
  'approval_id', 'approvalId', 'tool', 'toolName', 'summary',
  'expires_at', 'expiresAt', 'status', 'decision'
]);

function boundedPublicValue(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function selectPayload(payload: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => fields.has(key))
      .map(([key, value]) => [key, boundedPublicValue(value)])
      .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
  );
}

export function publicRunEvent(event: RunEvent): RunEvent {
  let payload: Record<string, unknown> = {};
  if (event.type === 'tool_approval_requested'
    || event.type === 'tool_approval_approved'
    || event.type === 'tool_approval_rejected'
    || event.type === 'tool_approval_expired') {
    payload = selectPayload(event.payload || {}, APPROVAL_PAYLOAD_FIELDS);
  } else if (event.type === 'run_failed') {
    payload = selectPayload(event.payload || {}, new Set(['code']));
  } else if (event.type === 'run_cancelled') {
    payload = selectPayload(event.payload || {}, new Set(['reason']));
  }
  return { ...event, payload };
}

export function publicWorkflowExecutionEvent(event: WorkflowExecutionStreamEvent): WorkflowExecutionStreamEvent {
  const allowedFields = event.type === 'execution_created'
    ? new Set(['workflowId', 'workflowVersion', 'status', 'triggerType'])
    : event.type === 'run_created'
      ? new Set(['attemptNumber', 'status', 'targetId', 'targetType'])
      : event.type === 'approval_requested' || event.type === 'approval_decided'
        ? new Set(['approvalKind', 'toolName', 'summary', 'status', 'decision', 'expiresAt'])
        : event.type === 'execution_status_changed'
          ? new Set(['status', 'nextRunId'])
          : new Set<string>();
  const runEvent = event.type === 'run_event'
    ? event.payload.runEvent as RunEvent | undefined
    : undefined;
  return {
    ...event,
    payload: runEvent
      ? { runEvent: publicRunEvent(runEvent) }
      : selectPayload(event.payload || {}, allowedFields)
  };
}

export function publicWorkflowRun(run: WorkflowRunRecord, includeOutput: boolean): Record<string, unknown> {
  return {
    id: run.id,
    executionId: run.executionId,
    workspaceId: run.workspaceId,
    workflowId: run.workflowId,
    workflowSessionId: includeOutput ? run.workflowSessionId : undefined,
    attemptNumber: run.attemptNumber,
    executorRole: run.executorRole,
    parentRunId: run.parentRunId || null,
    ...(run.executorRole === 'specialist' ? { agentId: run.agentId, agentVersion: run.agentVersion } : {}),
    targetId: run.targetId || null,
    targetType: run.targetType || null,
    messageId: includeOutput ? run.messageId : undefined,
    status: run.status,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt || null,
    endedAt: run.endedAt || null,
    errorCode: run.errorCode?.slice(0, 128) || null,
    ...(includeOutput && run.assistantMessage ? { assistantMessage: run.assistantMessage } : {}),
    ...(includeOutput && run.usage ? { usage: run.usage } : {})
  };
}

export function publicTroubleshootingRun(run: Run, includeOutput: boolean): Record<string, unknown> {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    targetId: run.targetId,
    targetType: run.targetType,
    sessionId: includeOutput ? run.sessionId : undefined,
    messageId: includeOutput ? run.messageId : undefined,
    toolAccessMode: run.toolAccessMode,
    status: run.status,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt || null,
    endedAt: run.endedAt || null,
    errorCode: run.errorCode?.slice(0, 128) || null,
    ...(includeOutput && run.assistantMessage ? { assistantMessage: run.assistantMessage } : {}),
    ...(includeOutput && run.usage ? { usage: run.usage } : {})
  };
}

type PublicApprovalSource = RunToolApproval | WorkflowApprovalRecord | AutomationRunApproval;

export function publicRunApproval(approval: PublicApprovalSource): Record<string, unknown> {
  const source = approval as PublicApprovalSource & {
    workflowId?: string;
    executionId?: string;
    sourceType?: string;
    approvalKind?: string;
    targetId?: string;
    targetType?: string;
  };
  return {
    id: source.id,
    runId: source.runId,
    workspaceId: source.workspaceId,
    ...(source.workflowId ? { workflowId: source.workflowId } : {}),
    ...(source.executionId ? { executionId: source.executionId } : {}),
    ...(source.sourceType ? { sourceType: source.sourceType } : {}),
    ...(source.approvalKind ? { approvalKind: source.approvalKind } : {}),
    ...(source.targetId ? { targetId: source.targetId } : {}),
    ...(source.targetType ? { targetType: source.targetType } : {}),
    toolName: source.toolName.slice(0, 200),
    ...(source.summary ? { summary: source.summary.slice(0, 500) } : {}),
    status: source.status,
    executionStatus: source.executionStatus,
    ...(source.decision ? { decision: source.decision } : {}),
    createdAt: source.createdAt,
    ...(source.decidedAt ? { decidedAt: source.decidedAt } : {}),
    expiresAt: source.expiresAt
  };
}
