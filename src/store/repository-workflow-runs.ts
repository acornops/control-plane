import { randomUUID } from 'node:crypto';
import type { RunEvent, RunStatus, ToolApprovalStatus } from '../types/domain.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess } from '../types/workflows.js';

export interface WorkflowSessionRecord {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
  createdAt: string;
}

export interface WorkflowMessageRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  workflowId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  inputs: Record<string, unknown>;
  runId?: string;
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowRunId: string;
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  messageId: string;
  createdBy: string;
  status: RunStatus;
  compiledAccessScope: CompiledWorkflowAccessScope;
  llmProvider?: 'openai' | 'anthropic' | 'gemini';
  llmModel?: string;
  llmReasoningSummaryMode?: 'off' | 'auto' | 'concise' | 'detailed';
  llmReasoningEffort?: 'default' | 'low' | 'medium' | 'high';
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  assistantMessage?: {
    content: string;
    format?: string;
  };
  usage?: unknown;
  events?: RunEvent[];
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowApprovalRecord {
  id: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  workflowRunId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
  status: ToolApprovalStatus;
  executionStatus: 'not_started' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  requestedBy?: string;
  decidedBy?: string;
  decision?: 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

const workflowSessions = new Map<string, WorkflowSessionRecord>();
const workflowMessages = new Map<string, WorkflowMessageRecord>();
const workflowRuns = new Map<string, WorkflowRunRecord>();
const workflowApprovals = new Map<string, WorkflowApprovalRecord>();

export function createWorkflowSession(params: {
  workflow: WorkflowDefinitionForAccess;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
}): WorkflowSessionRecord {
  const session: WorkflowSessionRecord = {
    id: randomUUID(),
    workflowId: params.workflow.id,
    workspaceId: params.workflow.workspaceId,
    workflowVersion: params.workflow.version,
    createdBy: params.createdBy,
    compiledAccessScope: params.compiledAccessScope,
    createdAt: new Date().toISOString()
  };
  workflowSessions.set(session.id, session);
  return session;
}

export function listWorkflowSessions(workspaceId: string, workflowId: string): WorkflowSessionRecord[] {
  return [...workflowSessions.values()]
    .filter((session) => session.workspaceId === workspaceId && session.workflowId === workflowId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getWorkflowSession(sessionId: string): WorkflowSessionRecord | null {
  return workflowSessions.get(sessionId) || null;
}

export function createWorkflowUserMessage(params: {
  session: WorkflowSessionRecord;
  content: string;
  inputs?: Record<string, unknown>;
}): WorkflowMessageRecord {
  const message: WorkflowMessageRecord = {
    id: randomUUID(),
    sessionId: params.session.id,
    workspaceId: params.session.workspaceId,
    workflowId: params.session.workflowId,
    role: 'user',
    content: params.content,
    inputs: params.inputs || {},
    createdAt: new Date().toISOString()
  };
  workflowMessages.set(message.id, message);
  return message;
}

export function createWorkflowRun(params: {
  session: WorkflowSessionRecord;
  message: WorkflowMessageRecord;
  workflowStepId?: string;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): WorkflowRunRecord {
  const now = new Date().toISOString();
  const approvalGates = params.session.compiledAccessScope.approvalGates;
  const run: WorkflowRunRecord = {
    id: randomUUID(),
    workflowRunId: randomUUID(),
    workspaceId: params.session.workspaceId,
    workflowId: params.session.workflowId,
    workflowSessionId: params.session.id,
    workflowStepId: params.workflowStepId,
    messageId: params.message.id,
    createdBy: params.session.createdBy,
    status: approvalGates.length > 0 ? 'waiting_for_approval' : 'queued',
    compiledAccessScope: params.session.compiledAccessScope,
    llmProvider: params.llmProvider,
    llmModel: params.llmModel,
    llmReasoningSummaryMode: params.llmReasoningSummaryMode,
    llmReasoningEffort: params.llmReasoningEffort,
    requestedAt: now,
    createdAt: now
  };
  workflowRuns.set(run.id, run);
  workflowMessages.set(params.message.id, { ...params.message, runId: run.id });
  for (const [index, gate] of approvalGates.entries()) {
    const approval: WorkflowApprovalRecord = {
      id: randomUUID(),
      runId: run.id,
      workspaceId: run.workspaceId,
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
      workflowSessionId: run.workflowSessionId,
      workflowStepId: run.workflowStepId,
      toolCallId: `workflow-gate-${index + 1}`,
      toolName: 'workflow.approval_gate',
      summary: gate,
      arguments: {
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        workflowStepId: run.workflowStepId || null
      },
      status: 'pending',
      executionStatus: 'not_started',
      requestedBy: run.createdBy,
      createdAt: now,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
    workflowApprovals.set(approval.id, approval);
  }
  return run;
}

export function getWorkflowRun(runId: string): WorkflowRunRecord | null {
  return workflowRuns.get(runId) || null;
}

export function listWorkflowRunsForSession(sessionId: string): WorkflowRunRecord[] {
  return [...workflowRuns.values()]
    .filter((run) => run.workflowSessionId === sessionId)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

export function listWorkflowRunApprovals(runId: string): WorkflowApprovalRecord[] {
  return [...workflowApprovals.values()]
    .filter((approval) => approval.runId === runId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function listWorkflowApprovalsForWorkspace(
  workspaceId: string,
  status: 'pending' | 'decided' | 'all' = 'pending'
): WorkflowApprovalRecord[] {
  return [...workflowApprovals.values()]
    .filter((approval) => approval.workspaceId === workspaceId)
    .filter((approval) => {
      if (status === 'all') return true;
      if (status === 'pending') return approval.status === 'pending';
      return approval.status !== 'pending';
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getWorkflowRunApproval(approvalId: string): WorkflowApprovalRecord | null {
  return workflowApprovals.get(approvalId) || null;
}

export function decideWorkflowRunApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): WorkflowApprovalRecord | null {
  const approval = workflowApprovals.get(approvalId);
  if (!approval) {
    return null;
  }
  if (approval.status !== 'pending') {
    return approval;
  }
  const now = new Date().toISOString();
  const status: ToolApprovalStatus = new Date(approval.expiresAt).getTime() <= Date.now()
    ? 'expired'
    : decision === 'approved'
      ? 'approved'
      : 'rejected';
  const updated: WorkflowApprovalRecord = {
    ...approval,
    status,
    decision: status === 'approved' || status === 'rejected' ? decision : approval.decision,
    decidedBy: status === 'approved' || status === 'rejected' ? decidedBy : approval.decidedBy,
    decidedAt: status === 'approved' || status === 'rejected' ? now : approval.decidedAt
  };
  workflowApprovals.set(approvalId, updated);
  return updated;
}

export function listWorkflowMessages(sessionId: string): WorkflowMessageRecord[] {
  return [...workflowMessages.values()]
    .filter((message) => message.sessionId === sessionId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function appendWorkflowRunEvents(runId: string, events: RunEvent[]): RunEvent[] {
  const run = workflowRuns.get(runId);
  if (!run) {
    return [];
  }
  const existingEvents = run.events || [];
  const nextEvents = [...existingEvents, ...events];
  workflowRuns.set(runId, { ...run, events: nextEvents, updatedAt: new Date().toISOString() });
  return events;
}

export function updateWorkflowRun(runId: string, update: Partial<Omit<WorkflowRunRecord, 'id'>>): WorkflowRunRecord | null {
  const run = workflowRuns.get(runId);
  if (!run) {
    return null;
  }
  const updated = { ...run, ...update, updatedAt: new Date().toISOString() };
  workflowRuns.set(runId, updated);
  return updated;
}

export function upsertWorkflowAssistantFinalMessage(params: {
  sessionId: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  content: string;
}): WorkflowMessageRecord {
  const existing = [...workflowMessages.values()].find(
    (message) => message.sessionId === params.sessionId && message.runId === params.runId && message.role === 'assistant'
  );
  const message: WorkflowMessageRecord = {
    id: existing?.id || randomUUID(),
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    role: 'assistant',
    content: params.content,
    inputs: {},
    runId: params.runId,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  workflowMessages.set(message.id, message);
  return message;
}


export function resetWorkflowRunRepositoryForTests(): void {
  workflowSessions.clear();
  workflowMessages.clear();
  workflowRuns.clear();
  workflowApprovals.clear();
}
