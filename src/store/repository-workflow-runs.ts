import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { RunEvent, RunStatus } from '../types/domain.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess } from '../types/workflows.js';
import type { AgentDefinition } from '../types/agents.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import { digestBindings, digestPrompt } from '../services/prompt-resources/index.js';
import { withTransaction } from './repository-transaction.js';
import type { RunRequestProvenance } from './repository-run-provenance.js';
import type { WorkflowExecutionStreamEvent } from './repository-workflow-execution-events.js';
import { insertInitialWorkflowExecutionEvents } from './repository-workflow-initial-events.js';
import {
  WORKFLOW_COORDINATOR_INSTRUCTIONS,
  WORKFLOW_COORDINATOR_PROFILE_VERSION
} from '../services/workflow-coordinator.js';
import { insertWorkflowRunApprovals } from './repository-workflow-run-approvals.js';

export interface WorkflowSessionRecord {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  workflowSnapshot?: WorkflowDefinitionForAccess;
  createdBy: string;
  requestProvenance: RunRequestProvenance;
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
  runId?: string;
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  executionId: string;
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  attemptNumber: number;
  executorRole: 'coordinator' | 'specialist';
  parentRunId?: string;
  delegationCallId?: string;
  delegationCapabilityId?: string;
  delegationRequired?: boolean;
  agentId?: string;
  agentVersion?: number;
  executorSnapshot:
    | { role: 'coordinator'; profileVersion: number; instructions: string }
    | { role: 'specialist'; agentId: string; agentVersion: number; agent: AgentDefinition };
  targetId?: string;
  targetType?: string;
  idempotencyKey: string;
  messageId: string;
  createdBy: string;
  status: RunStatus | 'needs_review';
  compiledAccessScope: CompiledWorkflowAccessScope;
  prompt: string;
  promptDigest: string;
  bindingDigest: string;
  resourceBindings: PromptResourceBinding[];
  resolvedAt: string;
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
  triggerType: string;
  triggerId?: string;
  occurrenceKey?: string;
  clientRequestId?: string;
  requestProvenance: RunRequestProvenance;
  prompt: string;
  promptDigest: string;
  bindingDigest: string;
  resourceBindings: PromptResourceBinding[];
  resolvedAt: string;
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

type Row = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapSession(row: Row): WorkflowSessionRecord {
  return {
    id: row.id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
    workflowVersion: row.workflow_version, createdBy: row.created_by,
    workflowSnapshot: row.workflow_snapshot || undefined,
    requestProvenance: {
      actorType: row.request_actor_type || 'user',
      ...(row.request_external_integration_link_id ? { externalIntegrationLinkId: row.request_external_integration_link_id } : {}),
      ...(row.request_external_integration_client_id ? { externalIntegrationClientId: row.request_external_integration_client_id } : {})
    },
    compiledAccessScope: row.compiled_access_scope, createdAt: iso(row.created_at)!
  };
}

export function mapMessage(row: Row): WorkflowMessageRecord {
  return {
    id: row.id, sessionId: row.session_id, workspaceId: row.workspace_id,
    workflowId: row.workflow_id, role: row.role, content: row.content,
    runId: row.run_id || undefined, createdAt: iso(row.created_at)!
  };
}

export function mapRun(row: Row, events?: RunEvent[]): WorkflowRunRecord {
  return {
    id: row.id, executionId: row.execution_id,
    workspaceId: row.workspace_id, workflowId: row.workflow_id,
    workflowSessionId: row.workflow_session_id, attemptNumber: row.attempt_number || 1,
    executorRole: row.executor_role,
    parentRunId: row.parent_run_id || undefined,
    delegationCallId: row.delegation_call_id || undefined,
    delegationCapabilityId: row.delegation_capability_id || undefined,
    delegationRequired: row.delegation_required ?? undefined,
    agentId: row.agent_id || undefined, agentVersion: row.agent_version || undefined,
    executorSnapshot: row.executor_snapshot,
    targetId: row.target_id || undefined, targetType: row.target_type || undefined,
    idempotencyKey: row.idempotency_key, messageId: row.message_id, createdBy: row.created_by,
    status: row.status, compiledAccessScope: row.compiled_access_scope,
    prompt: row.prompt_text || '', promptDigest: row.prompt_digest || '', bindingDigest: row.binding_digest || '',
    resourceBindings: row.resource_bindings || [], resolvedAt: iso(row.resolved_at) || iso(row.requested_at)!,
    llmProvider: row.llm_provider || undefined, llmModel: row.llm_model || undefined,
    llmReasoningSummaryMode: row.llm_reasoning_summary_mode || undefined,
    llmReasoningEffort: row.llm_reasoning_effort || undefined,
    requestedAt: iso(row.requested_at)!, startedAt: iso(row.started_at), endedAt: iso(row.ended_at),
    errorCode: row.error_code || undefined, errorMessage: row.error_message || undefined,
    assistantMessage: row.assistant_message || undefined, usage: row.usage || undefined,
    events, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)
  };
}

export async function loadWorkflowRunEvents(runId: string): Promise<RunEvent[]> {
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
  requestProvenance?: RunRequestProvenance;
  sessionId?: string;
}): Promise<WorkflowSessionRecord> {
  const provenance = params.requestProvenance || { actorType: 'user' };
  const result = await db.query<Row>(
    `INSERT INTO workflow_sessions (
       id,workspace_id,workflow_id,workflow_version,created_by,compiled_access_scope,workflow_snapshot,
       request_actor_type,request_external_integration_link_id,request_external_integration_client_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [params.sessionId || randomUUID(), params.workflow.workspaceId, params.workflow.id, params.workflow.version,
     params.createdBy, params.compiledAccessScope, params.workflow, provenance.actorType,
     provenance.externalIntegrationLinkId || null, provenance.externalIntegrationClientId || null]
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
}): Promise<WorkflowMessageRecord> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content)
     VALUES ($1,$2,$3,$4,'user',$5) RETURNING *`,
    [randomUUID(), params.session.id, params.session.workspaceId, params.session.workflowId, params.content]
  );
  return mapMessage(result.rows[0]);
}

export async function createWorkflowRun(params: {
  session: WorkflowSessionRecord;
  message: WorkflowMessageRecord;
  executionId?: string;
  executorSnapshot?: WorkflowRunRecord['executorSnapshot'];
  targetId?: string;
  targetType?: string;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): Promise<WorkflowRunRecord> {
  return withTransaction(async (client) => {
    const executionId = params.executionId || randomUUID();
    const resourceBindings = params.session.compiledAccessScope.resourceBindings || [];
    const promptDigest = digestPrompt(params.message.content);
    const bindingDigest = digestBindings(resourceBindings);
    const resolvedAt = new Date().toISOString();
    await client.query(
      `INSERT INTO workflow_executions (
        id,workspace_id,workflow_id,workflow_version,workflow_session_id,message_id,created_by,status,workflow_snapshot,
        prompt_text,prompt_digest,binding_digest,resource_bindings,resolved_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [executionId, params.session.workspaceId, params.session.workflowId, params.session.workflowVersion,
       params.session.id, params.message.id, params.session.createdBy,
       { id: params.session.workflowId, version: params.session.workflowVersion }, params.message.content,
       promptDigest, bindingDigest, JSON.stringify(resourceBindings), resolvedAt]
    );
    const runId = randomUUID();
    const status = params.session.compiledAccessScope.approvalGates.length ? 'waiting_for_approval' : 'queued';
    const executor = params.session.compiledAccessScope.executor;
    const specialistAgent = executor.role === 'specialist'
      ? params.session.compiledAccessScope.selectedAgentSnapshots
          .find((agent) => agent.id === executor.agentId && agent.version === executor.agentVersion)
      : undefined;
    const executorSnapshot = params.executorSnapshot || (
      executor.role === 'coordinator'
        ? { role: 'coordinator', profileVersion: WORKFLOW_COORDINATOR_PROFILE_VERSION, instructions: WORKFLOW_COORDINATOR_INSTRUCTIONS }
        : specialistAgent
          ? { role: 'specialist', agentId: executor.agentId, agentVersion: executor.agentVersion, agent: specialistAgent }
          : null
    );
    if (!executorSnapshot) throw new Error('SPECIALIST_EXECUTOR_SNAPSHOT_REQUIRED');
    const result = await client.query<Row>(
      `INSERT INTO workflow_runs (
        id,execution_id,workspace_id,workflow_id,workflow_session_id,
        attempt_number,executor_role,agent_id,agent_version,executor_snapshot,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,prompt_text,prompt_digest,binding_digest,resource_bindings,resolved_at,requested_at
       ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW()) RETURNING *`,
      [runId, executionId, params.session.workspaceId, params.session.workflowId, params.session.id,
       executor.role, executor.role === 'specialist' ? executor.agentId : null,
       executor.role === 'specialist' ? executor.agentVersion : null,
       executorSnapshot, params.targetId || null, params.targetType || null,
       `${executionId}:${params.session.compiledAccessScope.promptDigest || 'none'}:${params.session.compiledAccessScope.bindingDigest || 'none'}:root:1`, params.message.id, params.session.createdBy, status,
       params.session.compiledAccessScope, params.llmProvider || null, params.llmModel || null,
       params.llmReasoningSummaryMode || null, params.llmReasoningEffort || null,
       params.message.content, promptDigest, bindingDigest, JSON.stringify(resourceBindings), resolvedAt]
    );
    const run = mapRun(result.rows[0], []);
    await client.query('UPDATE workflow_messages SET run_id=$1 WHERE id=$2', [run.id, params.message.id]);
    await insertWorkflowRunApprovals(client, run, params.session.compiledAccessScope.approvalGates);
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, run.executionId, run.id, run.idempotencyKey,
       { runId: run.id, executionId: run.executionId, workflowId: run.workflowId }]
    );
    return run;
  });
}

export async function createWorkflowExecution(params: {
  workflow: WorkflowDefinitionForAccess;
  session: WorkflowSessionRecord;
  compiledAccessScope?: CompiledWorkflowAccessScope;
  requestProvenance?: RunRequestProvenance;
  content: string;
  messageId?: string;
  triggerType?: string;
  triggerId?: string;
  occurrenceKey?: string;
  clientRequestId?: string;
  targetId?: string;
  targetType?: string;
  promptDigest: string;
  bindingDigest: string;
  resourceBindings: PromptResourceBinding[];
  resolvedAt: string;
  specialistSnapshot?: AgentDefinition;
  llmProvider?: WorkflowRunRecord['llmProvider'];
  llmModel?: string;
  llmReasoningSummaryMode?: WorkflowRunRecord['llmReasoningSummaryMode'];
  llmReasoningEffort?: WorkflowRunRecord['llmReasoningEffort'];
}): Promise<{
  execution: WorkflowExecutionRecord;
  message: WorkflowMessageRecord;
  run: WorkflowRunRecord;
  initialEvents: WorkflowExecutionStreamEvent[];
}> {
  return withTransaction(async (client) => {
    const compiledAccessScope = params.compiledAccessScope || params.session.compiledAccessScope;
    const provenance = params.requestProvenance || { actorType: 'user' };
    const executionId = randomUUID();
    const messageId = params.messageId || randomUUID();
    const executor = compiledAccessScope.executor;
    const executorSnapshot: WorkflowRunRecord['executorSnapshot'] = executor.role === 'coordinator'
      ? {
          role: 'coordinator',
          profileVersion: WORKFLOW_COORDINATOR_PROFILE_VERSION,
          instructions: WORKFLOW_COORDINATOR_INSTRUCTIONS
        }
      : {
          role: 'specialist',
          agentId: executor.agentId,
          agentVersion: executor.agentVersion,
          agent: params.specialistSnapshot || (() => { throw new Error('SPECIALIST_EXECUTOR_SNAPSHOT_REQUIRED'); })()
        };
    const approvalGates = compiledAccessScope.approvalGates;
    const messageResult = await client.query<Row>(
      `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content)
       VALUES ($1,$2,$3,$4,'user',$5) RETURNING *`,
      [messageId, params.session.id, params.session.workspaceId, params.session.workflowId, params.content]
    );
    await client.query(
      `INSERT INTO workflow_executions (
        id,workspace_id,workflow_id,workflow_version,workflow_session_id,message_id,created_by,trigger_type,
        trigger_id,occurrence_key,client_request_id,status,workflow_snapshot,approved_context_grants,
        prompt_text,prompt_digest,binding_digest,resource_bindings,resolved_at,
        request_actor_type,request_external_integration_link_id,request_external_integration_client_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [executionId, params.workflow.workspaceId, params.workflow.id, params.workflow.version, params.session.id,
       messageId, params.session.createdBy, params.triggerType || 'manual', params.triggerId || null,
       params.occurrenceKey || null, params.clientRequestId || null,
       approvalGates.length ? 'waiting_for_approval' : 'queued', params.workflow,
       JSON.stringify(compiledAccessScope.contextGrants), params.content, params.promptDigest,
       params.bindingDigest, JSON.stringify(params.resourceBindings), params.resolvedAt, provenance.actorType,
       provenance.externalIntegrationLinkId || null, provenance.externalIntegrationClientId || null]
    );
    const runId = randomUUID();
    const idempotencyKey = `${executionId}:${params.promptDigest}:${params.bindingDigest}:root:1`;
    const runResult = await client.query<Row>(
      `INSERT INTO workflow_runs (
        id,execution_id,workspace_id,workflow_id,workflow_session_id,
        attempt_number,executor_role,agent_id,agent_version,executor_snapshot,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,prompt_text,prompt_digest,binding_digest,resource_bindings,resolved_at,requested_at
       ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW()) RETURNING *`,
      [runId, executionId, params.workflow.workspaceId, params.workflow.id, params.session.id,
       executor.role,
       executor.role === 'specialist' ? executor.agentId : null,
       executor.role === 'specialist' ? executor.agentVersion : null,
       executorSnapshot, params.targetId || null, params.targetType || null,
       idempotencyKey, messageId, params.session.createdBy,
       approvalGates.length ? 'waiting_for_approval' : 'queued', compiledAccessScope,
       params.llmProvider || null, params.llmModel || null,
       params.llmReasoningSummaryMode || null, params.llmReasoningEffort || null,
       params.content, params.promptDigest, params.bindingDigest, JSON.stringify(params.resourceBindings), params.resolvedAt]
    );
    const run = mapRun(runResult.rows[0], []);
    await client.query('UPDATE workflow_messages SET run_id=$1 WHERE id=$2', [runId, messageId]);
    const approvals = await insertWorkflowRunApprovals(client, run, approvalGates);
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, executionId, runId, idempotencyKey,
       { runId, executionId, workflowId: run.workflowId }]
    );
    const executionResult = await client.query<Row>('SELECT * FROM workflow_executions WHERE id=$1', [executionId]);
    const row = executionResult.rows[0];
    const initialEvents = await insertInitialWorkflowExecutionEvents(client, {
      execution: {
        id: executionId,
        workspaceId: run.workspaceId,
        workflowId: params.workflow.id,
        workflowSessionId: params.session.id,
        workflowVersion: params.workflow.version,
        status: row.status,
        triggerType: params.triggerType || 'manual'
      },
      run,
      approvals
    });
    return {
      execution: {
        id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
        workflowVersion: row.workflow_version, workflowSessionId: row.workflow_session_id,
        messageId: row.message_id, createdBy: row.created_by, status: row.status,
        triggerType: row.trigger_type,
        triggerId: row.trigger_id || undefined, occurrenceKey: row.occurrence_key || undefined,
        clientRequestId: row.client_request_id || undefined,
        requestProvenance: {
          actorType: row.request_actor_type || 'user',
          ...(row.request_external_integration_link_id ? { externalIntegrationLinkId: row.request_external_integration_link_id } : {}),
          ...(row.request_external_integration_client_id ? { externalIntegrationClientId: row.request_external_integration_client_id } : {})
        },
        prompt: row.prompt_text || '', promptDigest: row.prompt_digest || '', bindingDigest: row.binding_digest || '',
        resourceBindings: row.resource_bindings || [], resolvedAt: iso(row.resolved_at) || iso(row.created_at)!,
        createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!
      },
      message: mapMessage(messageResult.rows[0]), run, initialEvents
    };
  });
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_runs WHERE id=$1', [runId]);
  if (!result.rowCount) return null;
  return mapRun(result.rows[0], await loadWorkflowRunEvents(runId));
}

export async function listWorkflowExecutionAttempts(executionId: string): Promise<WorkflowRunRecord[]> {
  const result = await db.query<Row>(
    'SELECT * FROM workflow_runs WHERE execution_id=$1 AND parent_run_id IS NULL ORDER BY requested_at,attempt_number,id',
    [executionId]
  );
  return Promise.all(result.rows.map(async (row) => mapRun(row, await loadWorkflowRunEvents(row.id))));
}

export async function listWorkflowRunsForSession(sessionId: string): Promise<WorkflowRunRecord[]> {
  const result = await db.query<Row>('SELECT * FROM workflow_runs WHERE workflow_session_id=$1 ORDER BY requested_at DESC,id DESC', [sessionId]);
  return Promise.all(result.rows.map(async (row) => mapRun(row, await loadWorkflowRunEvents(row.id))));
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

async function updateWorkflowRunMatching(
  runId: string,
  update: Partial<Omit<WorkflowRunRecord,'id'>>,
  currentStatuses?: string[]
): Promise<WorkflowRunRecord | null> {
  const allowed: Record<string,string> = {
    status:'status', startedAt:'started_at', endedAt:'ended_at', errorCode:'error_code', errorMessage:'error_message',
    assistantMessage:'assistant_message', usage:'usage', targetId:'target_id', targetType:'target_type'
  };
  const entries = Object.entries(update).filter(([key]) => allowed[key]);
  if (!entries.length) return getWorkflowRun(runId);
  const values: unknown[] = [runId];
  const sets = entries.map(([key,value]) => { values.push(value ?? null); return `${allowed[key]}=$${values.length}`; });
  if (currentStatuses) values.push(currentStatuses);
  const statusGuard = currentStatuses ? ` AND status=ANY($${values.length}::text[])` : '';
  const result = await db.query<Row>(`UPDATE workflow_runs SET ${sets.join(',')},updated_at=NOW() WHERE id=$1${statusGuard} RETURNING *`, values);
  return result.rowCount ? mapRun(result.rows[0], await loadWorkflowRunEvents(runId)) : null;
}

export function updateWorkflowRun(runId: string, update: Partial<Omit<WorkflowRunRecord,'id'>>): Promise<WorkflowRunRecord | null> {
  return updateWorkflowRunMatching(runId, update);
}

export function updateWorkflowRunIfStatus(runId: string, currentStatuses: string[], update: Partial<Omit<WorkflowRunRecord,'id'>>): Promise<WorkflowRunRecord | null> {
  return updateWorkflowRunMatching(runId, update, currentStatuses);
}

export async function upsertWorkflowAssistantFinalMessage(params: {sessionId:string;runId:string;workspaceId:string;workflowId:string;content:string}): Promise<WorkflowMessageRecord> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_messages (id,session_id,workspace_id,workflow_id,role,content,run_id)
     VALUES ($1,$2,$3,$4,'assistant',$5,$6)
     ON CONFLICT (run_id) WHERE role='assistant' AND run_id IS NOT NULL
     DO UPDATE SET content=EXCLUDED.content RETURNING *`,
    [randomUUID(), params.sessionId, params.workspaceId, params.workflowId, params.content, params.runId]
  );
  return mapMessage(result.rows[0]);
}

// Tests mock the database at the repository boundary; production state is never process-local.
export function resetWorkflowRunRepositoryForTests(): void {}
