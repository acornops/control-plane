import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import type { RunEvent, RunStatus, ToolApprovalStatus } from '../types/domain.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess, WorkflowStepDefinition } from '../types/workflows.js';
import { withTransaction } from './repository-transaction.js';

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
  executionId: string;
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  workflowStepId?: string;
  stepIndex: number;
  attemptNumber: number;
  agentId?: string;
  agentVersion?: number;
  agentSnapshot?: Record<string, unknown>;
  stepSnapshot?: WorkflowStepDefinition;
  targetId?: string;
  targetType?: string;
  idempotencyKey: string;
  messageId: string;
  createdBy: string;
  status: RunStatus | 'needs_review';
  compiledAccessScope: CompiledWorkflowAccessScope;
  llmProvider?: 'openai' | 'anthropic' | 'gemini';
  llmModel?: string;
  llmReasoningSummaryMode?: 'off' | 'auto' | 'concise' | 'detailed';
  llmReasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  assistantMessage?: { content: string; format?: string };
  usage?: unknown;
  events?: RunEvent[];
  createdAt: string;
  updatedAt?: string;
}

export interface WorkflowExecutionRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: number;
  workflowSessionId: string;
  messageId: string;
  createdBy: string;
  status: string;
  currentStepIndex: number;
  triggerType: string;
  triggerId?: string;
  occurrenceKey?: string;
  clientRequestId?: string;
  inputContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

type Row = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapSession(row: Row): WorkflowSessionRecord {
  return {
    id: row.id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
    workflowVersion: row.workflow_version, createdBy: row.created_by,
    compiledAccessScope: row.compiled_access_scope, createdAt: iso(row.created_at)!
  };
}

function mapMessage(row: Row): WorkflowMessageRecord {
  return {
    id: row.id, sessionId: row.session_id, workspaceId: row.workspace_id,
    workflowId: row.workflow_id, role: row.role, content: row.content,
    inputs: row.inputs || {}, runId: row.run_id || undefined, createdAt: iso(row.created_at)!
  };
}

function mapRun(row: Row, events?: RunEvent[]): WorkflowRunRecord {
  return {
    id: row.id, workflowRunId: row.workflow_run_id, executionId: row.execution_id,
    workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowSessionId: row.workflow_session_id, workflowStepId: row.workflow_step_id || undefined,
    stepIndex: row.step_index || 0, attemptNumber: row.attempt_number || 1,
    agentId: row.agent_id || undefined, agentVersion: row.agent_version || undefined,
    agentSnapshot: row.agent_snapshot || undefined, stepSnapshot: row.step_snapshot || undefined,
    targetId: row.target_id || undefined, targetType: row.target_type || undefined,
    idempotencyKey: row.idempotency_key, messageId: row.message_id, createdBy: row.created_by,
    status: row.status, compiledAccessScope: row.step_scope || row.compiled_access_scope,
    llmProvider: row.llm_provider || undefined, llmModel: row.llm_model || undefined,
    llmReasoningSummaryMode: row.llm_reasoning_summary_mode || undefined,
    llmReasoningEffort: row.llm_reasoning_effort || undefined,
    requestedAt: iso(row.requested_at)!, startedAt: iso(row.started_at), endedAt: iso(row.ended_at),
    errorCode: row.error_code || undefined, errorMessage: row.error_message || undefined,
    assistantMessage: row.assistant_message || undefined, usage: row.usage || undefined,
    events, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)
  };
}

function mapApproval(row: Row): WorkflowApprovalRecord {
  return {
    id: row.id, runId: row.run_id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowRunId: row.workflow_run_id, workflowSessionId: row.workflow_session_id,
    workflowStepId: row.workflow_step_id || undefined, toolCallId: row.tool_call_id,
    toolName: row.tool_name, summary: row.summary, arguments: row.arguments || {}, status: row.status,
    executionStatus: row.execution_status, requestedBy: row.requested_by || undefined,
    decidedBy: row.decided_by || undefined, decision: row.decision || undefined,
    createdAt: iso(row.created_at)!, decidedAt: iso(row.decided_at), expiresAt: iso(row.expires_at)!
  };
}

async function loadRunEvents(runId: string): Promise<RunEvent[]> {
  const result = await db.query<Row>(
    `SELECT run_id, seq, schema_version, event_type, occurred_at, payload
     FROM workflow_run_events WHERE run_id = $1 ORDER BY seq`, [runId]
  );
  return result.rows.map((row) => ({
    schema_version: row.schema_version, run_id: row.run_id, seq: row.seq,
    ts: iso(row.occurred_at)!, type: row.event_type, payload: row.payload || {}
  } as RunEvent));
}

export async function createWorkflowSession(params: {
  workflow: WorkflowDefinitionForAccess;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
}): Promise<WorkflowSessionRecord> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_sessions (id, workspace_id, workflow_id, workflow_version, created_by, compiled_access_scope)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [randomUUID(), params.workflow.workspaceId, params.workflow.id, params.workflow.version, params.createdBy, params.compiledAccessScope]
  );
  return mapSession(result.rows[0]);
}

export async function listWorkflowSessions(workspaceId: string, workflowId: string): Promise<WorkflowSessionRecord[]> {
  const result = await db.query<Row>(
    `SELECT * FROM workflow_sessions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY created_at DESC,id DESC`,
    [workspaceId, workflowId]
  );
  return result.rows.map(mapSession);
}

export async function getWorkflowSession(sessionId: string): Promise<WorkflowSessionRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_sessions WHERE id=$1', [sessionId]);
  return result.rowCount ? mapSession(result.rows[0]) : null;
}

export async function createWorkflowUserMessage(params: {
  session: WorkflowSessionRecord;
  content: string;
  inputs?: Record<string, unknown>;
}): Promise<WorkflowMessageRecord> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content,inputs)
     VALUES ($1,$2,$3,$4,'user',$5,$6) RETURNING *`,
    [randomUUID(), params.session.id, params.session.workspaceId, params.session.workflowId, params.content, params.inputs || {}]
  );
  return mapMessage(result.rows[0]);
}

async function insertApprovals(client: PoolClient, run: WorkflowRunRecord, approvalGates: string[]): Promise<void> {
  for (const [index, gate] of approvalGates.entries()) {
    await client.query(
      `INSERT INTO workflow_approvals (
         id,run_id,workspace_id,workflow_id,workflow_run_id,workflow_session_id,workflow_step_id,
         tool_call_id,tool_name,summary,arguments,status,execution_status,requested_by,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'workflow.approval_gate',$9,$10,'pending','not_started',$11,NOW()+INTERVAL '15 minutes')`,
      [randomUUID(), run.id, run.workspaceId, run.workflowId, run.workflowRunId, run.workflowSessionId,
       run.workflowStepId || null, `workflow-gate-${index + 1}`, gate,
       { executionId: run.executionId, workflowId: run.workflowId, workflowStepId: run.workflowStepId || null }, run.createdBy]
    );
  }
}

export async function createWorkflowRun(params: {
  session: WorkflowSessionRecord;
  message: WorkflowMessageRecord;
  workflowStepId?: string;
  stepIndex?: number;
  executionId?: string;
  stepSnapshot?: WorkflowStepDefinition;
  agentId?: string;
  agentVersion?: number;
  agentSnapshot?: Record<string, unknown>;
  targetId?: string;
  targetType?: string;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): Promise<WorkflowRunRecord> {
  return withTransaction(async (client) => {
    const executionId = params.executionId || randomUUID();
    await client.query(
      `INSERT INTO workflow_executions (
        id,workspace_id,workflow_id,workflow_version,workflow_session_id,message_id,created_by,status,workflow_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8) ON CONFLICT (id) DO NOTHING`,
      [executionId, params.session.workspaceId, params.session.workflowId, params.session.workflowVersion,
       params.session.id, params.message.id, params.session.createdBy,
       { id: params.session.workflowId, version: params.session.workflowVersion }]
    );
    const runId = randomUUID();
    const stepIndex = params.stepIndex || 0;
    const status = params.session.compiledAccessScope.approvalGates.length ? 'waiting_for_approval' : 'queued';
    const result = await client.query<Row>(
      `INSERT INTO workflow_runs (
        id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,workflow_step_id,
        step_index,attempt_number,agent_id,agent_version,agent_snapshot,step_snapshot,step_scope,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,requested_at
       ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$12,$19,$20,$21,$22,NOW()) RETURNING *`,
      [runId, executionId, params.session.workspaceId, params.session.workflowId, params.session.id,
       params.workflowStepId || null, stepIndex, params.agentId || null, params.agentVersion || null,
       params.agentSnapshot || null, params.stepSnapshot || null, params.session.compiledAccessScope,
       params.targetId || null, params.targetType || null, `${executionId}:${stepIndex}:1`, params.message.id,
       params.session.createdBy, status, params.llmProvider || null, params.llmModel || null,
       params.llmReasoningSummaryMode || null, params.llmReasoningEffort || null]
    );
    const run = mapRun(result.rows[0], []);
    await client.query('UPDATE workflow_messages SET run_id=$1 WHERE id=$2', [run.id, params.message.id]);
    await insertApprovals(client, run, params.session.compiledAccessScope.approvalGates);
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, run.executionId, run.id, run.idempotencyKey,
       { runId: run.id, executionId: run.executionId, workflowId: run.workflowId, stepIndex }]
    );
    return run;
  });
}

export async function createWorkflowExecution(params: {
  workflow: WorkflowDefinitionForAccess;
  session: WorkflowSessionRecord;
  content: string;
  inputs: Record<string, unknown>;
  triggerType?: string;
  triggerId?: string;
  occurrenceKey?: string;
  clientRequestId?: string;
  targetId?: string;
  targetType?: string;
  agentSnapshot?: Record<string, unknown>;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): Promise<{ execution: WorkflowExecutionRecord; message: WorkflowMessageRecord; run: WorkflowRunRecord }> {
  return withTransaction(async (client) => {
    const executionId = randomUUID();
    const messageId = randomUUID();
    const firstStep = params.workflow.steps[0];
    if (!firstStep || firstStep.agentIds?.length !== 1) throw new Error('Workflow first step must select exactly one Agent');
    const selected = params.session.compiledAccessScope.selectedAgents?.find((entry) => entry.stepId === firstStep.id);
    const agentId = firstStep.agentIds[0];
    const agentVersion = selected?.agentVersions[agentId];
    const approvalGates = firstStep.approvalRequired ? [`Approve workflow step: ${firstStep.title}`] : [];
    const stepTools = firstStep.allowedTools.length ? firstStep.allowedTools : params.session.compiledAccessScope.tools;
    const stepMcpServers = firstStep.allowedMcpServers.length
      ? firstStep.allowedMcpServers
      : params.session.compiledAccessScope.mcpServers;
    const stepToolOperations = Object.fromEntries(stepTools.map((tool) => [
      tool,
      params.session.compiledAccessScope.toolOperations[tool] || 'read'
    ]));
    const stepScope: CompiledWorkflowAccessScope = {
      ...params.session.compiledAccessScope,
      mcpServers: stepMcpServers,
      tools: stepTools,
      toolOperations: stepToolOperations,
      enabledSkills: firstStep.enabledSkills,
      contextGrants: firstStep.contextGrants,
      approvalGates,
      jwtClaims: {
        ...params.session.compiledAccessScope.jwtClaims,
        agent_id: agentId,
        agent_version: agentVersion,
        permissions: {
          allowed_tools: stepTools,
          allowed_tool_operations: stepToolOperations,
          context_grants: firstStep.contextGrants
        }
      }
    };
    const messageResult = await client.query<Row>(
      `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content,inputs)
       VALUES ($1,$2,$3,$4,'user',$5,$6) RETURNING *`,
      [messageId, params.session.id, params.session.workspaceId, params.session.workflowId, params.content, params.inputs]
    );
    await client.query(
      `INSERT INTO workflow_executions (
        id,workspace_id,workflow_id,workflow_version,workflow_session_id,message_id,created_by,trigger_type,
        trigger_id,occurrence_key,client_request_id,status,current_step_index,workflow_snapshot,input_context,approved_context_grants
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15)`,
      [executionId, params.workflow.workspaceId, params.workflow.id, params.workflow.version, params.session.id,
       messageId, params.session.createdBy, params.triggerType || 'manual', params.triggerId || null,
       params.occurrenceKey || null, params.clientRequestId || null,
       approvalGates.length ? 'waiting_for_approval' : 'queued', params.workflow, params.inputs,
       JSON.stringify(stepScope.contextGrants)]
    );
    const runId = randomUUID();
    const idempotencyKey = `${executionId}:0:1`;
    const runResult = await client.query<Row>(
      `INSERT INTO workflow_runs (
        id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,workflow_step_id,
        step_index,attempt_number,agent_id,agent_version,agent_snapshot,step_snapshot,step_scope,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,requested_at
       ) VALUES ($1,$2,$2,$3,$4,$5,$6,0,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$11,$18,$19,$20,$21,NOW()) RETURNING *`,
      [runId, executionId, params.workflow.workspaceId, params.workflow.id, params.session.id, firstStep.id,
       agentId, agentVersion || null, params.agentSnapshot || null, firstStep, stepScope,
       params.targetId || null, params.targetType || null, idempotencyKey, messageId, params.session.createdBy,
       approvalGates.length ? 'waiting_for_approval' : 'queued', params.llmProvider || null, params.llmModel || null,
       params.llmReasoningSummaryMode || null, params.llmReasoningEffort || null]
    );
    const run = mapRun(runResult.rows[0], []);
    await client.query('UPDATE workflow_messages SET run_id=$1 WHERE id=$2', [runId, messageId]);
    await insertApprovals(client, run, approvalGates);
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, executionId, runId, idempotencyKey,
       { runId, executionId, workflowId: run.workflowId, stepIndex: 0 }]
    );
    const executionResult = await client.query<Row>('SELECT * FROM workflow_executions WHERE id=$1', [executionId]);
    const row = executionResult.rows[0];
    return {
      execution: {
        id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
        workflowVersion: row.workflow_version, workflowSessionId: row.workflow_session_id,
        messageId: row.message_id, createdBy: row.created_by, status: row.status,
        currentStepIndex: row.current_step_index, triggerType: row.trigger_type,
        triggerId: row.trigger_id || undefined, occurrenceKey: row.occurrence_key || undefined,
        clientRequestId: row.client_request_id || undefined, inputContext: row.input_context || {},
        createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!
      },
      message: mapMessage(messageResult.rows[0]), run
    };
  });
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_runs WHERE id=$1', [runId]);
  if (!result.rowCount) return null;
  return mapRun(result.rows[0], await loadRunEvents(runId));
}

export async function listWorkflowRunsForSession(sessionId: string): Promise<WorkflowRunRecord[]> {
  const result = await db.query<Row>('SELECT * FROM workflow_runs WHERE workflow_session_id=$1 ORDER BY requested_at DESC,id DESC', [sessionId]);
  return Promise.all(result.rows.map(async (row) => mapRun(row, await loadRunEvents(row.id))));
}

export async function listWorkflowRunApprovals(runId: string): Promise<WorkflowApprovalRecord[]> {
  const result = await db.query<Row>('SELECT * FROM workflow_approvals WHERE run_id=$1 ORDER BY created_at,id', [runId]);
  return result.rows.map(mapApproval);
}

export async function listWorkflowApprovalsForWorkspace(workspaceId: string, status: 'pending'|'decided'|'all'='pending'): Promise<WorkflowApprovalRecord[]> {
  const clause = status === 'all' ? '' : status === 'pending' ? "AND status='pending'" : "AND status<>'pending'";
  const result = await db.query<Row>(`SELECT * FROM workflow_approvals WHERE workspace_id=$1 ${clause} ORDER BY created_at DESC,id DESC`, [workspaceId]);
  return result.rows.map(mapApproval);
}

export async function getWorkflowRunApproval(approvalId: string): Promise<WorkflowApprovalRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_approvals WHERE id=$1', [approvalId]);
  return result.rowCount ? mapApproval(result.rows[0]) : null;
}

export async function decideWorkflowRunApproval(approvalId: string, decision: 'approved'|'rejected', decidedBy: string): Promise<WorkflowApprovalRecord | null> {
  const result = await db.query<Row>(
    `UPDATE workflow_approvals SET
       status=CASE WHEN expires_at<=NOW() THEN 'expired' ELSE $2 END,
       decision=CASE WHEN expires_at<=NOW() THEN decision ELSE $2 END,
       decided_by=CASE WHEN expires_at<=NOW() THEN decided_by ELSE $3 END,
       decided_at=CASE WHEN expires_at<=NOW() THEN decided_at ELSE NOW() END
     WHERE id=$1 AND status='pending' RETURNING *`, [approvalId, decision, decidedBy]
  );
  if (result.rowCount) return mapApproval(result.rows[0]);
  return getWorkflowRunApproval(approvalId);
}

export async function listWorkflowMessages(sessionId: string): Promise<WorkflowMessageRecord[]> {
  const result = await db.query<Row>('SELECT * FROM workflow_messages WHERE session_id=$1 ORDER BY created_at,id', [sessionId]);
  return result.rows.map(mapMessage);
}

export async function appendWorkflowRunEvents(runId: string, events: RunEvent[]): Promise<RunEvent[]> {
  const accepted: RunEvent[] = [];
  for (const event of events) {
    const result = await db.query(
      `INSERT INTO workflow_run_events (run_id,seq,schema_version,event_type,occurred_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,seq) DO NOTHING RETURNING seq`,
      [runId, event.seq, event.schema_version, event.type, event.ts, event.payload || {}]
    );
    if (result.rowCount) accepted.push(event);
  }
  return accepted;
}

export async function updateWorkflowRun(runId: string, update: Partial<Omit<WorkflowRunRecord,'id'>>): Promise<WorkflowRunRecord | null> {
  const allowed: Record<string,string> = {
    status:'status', startedAt:'started_at', endedAt:'ended_at', errorCode:'error_code', errorMessage:'error_message',
    assistantMessage:'assistant_message', usage:'usage', targetId:'target_id', targetType:'target_type'
  };
  const entries = Object.entries(update).filter(([key]) => allowed[key]);
  if (!entries.length) return getWorkflowRun(runId);
  const values: unknown[] = [runId];
  const sets = entries.map(([key,value]) => { values.push(value ?? null); return `${allowed[key]}=$${values.length}`; });
  const result = await db.query<Row>(`UPDATE workflow_runs SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`, values);
  return result.rowCount ? mapRun(result.rows[0], await loadRunEvents(runId)) : null;
}

export async function upsertWorkflowAssistantFinalMessage(params: {sessionId:string;runId:string;workspaceId:string;workflowId:string;content:string}): Promise<WorkflowMessageRecord> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content,inputs,run_id)
     VALUES ($1,$2,$3,$4,'assistant',$5,'{}',$6)
     ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content RETURNING *`,
    [randomUUID(), params.sessionId, params.workspaceId, params.workflowId, params.content, params.runId]
  );
  return mapMessage(result.rows[0]);
}

// Tests mock the database at the repository boundary; production state is never process-local.
export function resetWorkflowRunRepositoryForTests(): void {}
