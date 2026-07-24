import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { digestPrompt } from '../services/prompt-resources/index.js';
import type { AgentDefinition } from '../types/agents.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';
import { insertWorkflowRunApprovals } from './repository-workflow-run-approvals.js';
import { insertWorkflowExecutionEvent } from './repository-workflow-execution-events.js';
import {
  loadWorkflowRunEvents,
  mapRun,
  type WorkflowRunRecord
} from './repository-workflow-runs.js';
import { withTransaction } from './repository-transaction.js';

type Row = QueryResultRow;

export class WorkflowDelegationConflictError extends Error {
  constructor(readonly code:
    | 'DELEGATION_IDEMPOTENCY_CONFLICT'
    | 'DELEGATION_PARENT_INVALID'
    | 'DELEGATION_TOTAL_LIMIT'
    | 'DELEGATION_CONCURRENCY_LIMIT'
  ) {
    super(code);
    this.name = 'WorkflowDelegationConflictError';
  }
}

export async function createDelegatedWorkflowRun(params: {
  parent: WorkflowRunRecord;
  specialist: AgentDefinition;
  compiledAccessScope: CompiledWorkflowAccessScope;
  toolCallId: string;
  capabilityId: string;
  targetId: string;
  targetType: string;
  taskPrompt: string;
  required: boolean;
  maxConcurrentChildren: number;
  maxChildren: number;
}): Promise<{ run: WorkflowRunRecord; created: boolean }> {
  return withTransaction(async (client) => {
    const lockedParent = await client.query<Row>(
      'SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE',
      [params.parent.id]
    );
    const existing = await client.query<Row>(
      `SELECT * FROM workflow_runs
       WHERE parent_run_id=$1 AND delegation_call_id=$2
       FOR UPDATE`,
      [params.parent.id, params.toolCallId]
    );
    if (existing.rowCount) {
      const run = mapRun(existing.rows[0], []);
      const same = run.delegationCapabilityId === params.capabilityId
        && run.targetId === params.targetId
        && run.targetType === params.targetType
        && run.prompt === params.taskPrompt
        && run.delegationRequired === params.required;
      if (!same) throw new WorkflowDelegationConflictError('DELEGATION_IDEMPOTENCY_CONFLICT');
      return { run, created: false };
    }
    if (
      !lockedParent.rowCount
      || lockedParent.rows[0].executor_role !== 'coordinator'
      || lockedParent.rows[0].parent_run_id
      || lockedParent.rows[0].execution_id !== params.parent.executionId
      || !['dispatching', 'running'].includes(lockedParent.rows[0].status)
    ) {
      throw new WorkflowDelegationConflictError('DELEGATION_PARENT_INVALID');
    }
    const counts = await client.query<{ total: string; active: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status IN ('queued','dispatching','running','waiting_for_approval')) AS active
       FROM workflow_runs WHERE parent_run_id=$1`,
      [params.parent.id]
    );
    if (Number(counts.rows[0].total) >= params.maxChildren) {
      throw new WorkflowDelegationConflictError('DELEGATION_TOTAL_LIMIT');
    }
    if (Number(counts.rows[0].active) >= params.maxConcurrentChildren) {
      throw new WorkflowDelegationConflictError('DELEGATION_CONCURRENCY_LIMIT');
    }

    const runId = randomUUID();
    const status = params.specialist.approvalPolicy.mode === 'always' ? 'waiting_for_approval' : 'queued';
    const idempotencyKey = `${params.parent.id}:delegation:${params.toolCallId}`;
    const snapshot: WorkflowRunRecord['executorSnapshot'] = {
      role: 'specialist',
      agentId: params.specialist.id,
      agentVersion: params.specialist.version,
      agent: params.specialist
    };
    const result = await client.query<Row>(
      `INSERT INTO workflow_runs (
         id,execution_id,workspace_id,workflow_id,workflow_session_id,message_id,created_by,status,
         compiled_access_scope,llm_provider,llm_model,llm_reasoning_summary_mode,llm_reasoning_effort,
         requested_at,attempt_number,executor_role,parent_run_id,delegation_call_id,
         delegation_capability_id,delegation_required,agent_id,agent_version,executor_snapshot,
         target_id,target_type,idempotency_key,prompt_text,prompt_digest,binding_digest,
         resource_bindings,resolved_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),1,'specialist',$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
       ) RETURNING *`,
      [
        runId, params.parent.executionId, params.parent.workspaceId, params.parent.workflowId,
        params.parent.workflowSessionId, params.parent.messageId, params.parent.createdBy, status,
        params.compiledAccessScope, params.parent.llmProvider || null, params.parent.llmModel || null,
        params.parent.llmReasoningSummaryMode || null, params.parent.llmReasoningEffort || null,
        params.parent.id, params.toolCallId, params.capabilityId, params.required,
        params.specialist.id, params.specialist.version, snapshot, params.targetId, params.targetType,
        idempotencyKey, params.taskPrompt, digestPrompt(params.taskPrompt), params.parent.bindingDigest,
        JSON.stringify(params.parent.resourceBindings), params.parent.resolvedAt
      ]
    );
    const run = mapRun(result.rows[0], []);
    const approvals = status === 'waiting_for_approval'
      ? await insertWorkflowRunApprovals(client, run, [`Approve specialist work: ${params.specialist.name}`])
      : [];
    if (status === 'waiting_for_approval' && params.required) {
      await client.query(
        `UPDATE workflow_executions
         SET status='waiting_for_approval',updated_at=NOW()
         WHERE id=$1 AND status NOT IN ('completed','failed','cancelled','needs_review')`,
        [run.executionId]
      );
    }
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, run.executionId, run.id, run.idempotencyKey, {
        runId: run.id,
        executionId: run.executionId,
        workflowId: run.workflowId,
        executorRole: run.executorRole,
        parentRunId: run.parentRunId
      }]
    );
    await insertWorkflowExecutionEvent(client, {
      executionId: run.executionId,
      workspaceId: run.workspaceId,
      type: 'run_created',
      runId: run.id,
      dedupeKey: `run-created:${run.id}`,
      payload: {
        executorRole: run.executorRole,
        parentRunId: run.parentRunId,
        agentId: run.agentId || null,
        attemptNumber: run.attemptNumber,
        capabilityId: run.delegationCapabilityId,
        targetId: run.targetId || null,
        targetType: run.targetType || null,
        required: run.delegationRequired,
        status: run.status
      }
    });
    for (const approval of approvals) {
      await insertWorkflowExecutionEvent(client, {
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
    return { run, created: true };
  });
}

export async function listWorkflowChildRuns(parentRunId: string): Promise<WorkflowRunRecord[]> {
  const result = await db.query<Row>(
    'SELECT * FROM workflow_runs WHERE parent_run_id=$1 ORDER BY requested_at,id',
    [parentRunId]
  );
  return Promise.all(result.rows.map(async (row) => mapRun(row, await loadWorkflowRunEvents(row.id))));
}
