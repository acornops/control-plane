import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import { withTransaction } from '../store/repository-transaction.js';
import type { TargetType } from '../types/domain.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';

type Artifact = { id: string; type: string; title: string };

export interface WorkflowRetrySnapshot {
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  messageId: string;
  agentId: string;
  agentVersion: number;
  agentSnapshot: Record<string, unknown>;
  targetId?: string;
  targetType?: TargetType;
  compiledAccessScope: CompiledWorkflowAccessScope;
  prompt: string;
  promptDigest: string;
  bindingDigest: string;
  resourceBindings: PromptResourceBinding[];
  resolvedAt: string;
}

/** Workflow V2 has exactly one entry run. Delegated children are separate runs. */
export async function advanceWorkflowExecution(
  run: WorkflowRunRecord,
  terminalStatus: 'completed' | 'failed' | 'cancelled',
  _artifacts: Artifact[] = []
): Promise<{ executionStatus: string }> {
  return withTransaction(async (client) => {
    const execution = await client.query<QueryResultRow>(
      'SELECT status FROM workflow_executions WHERE id=$1 FOR UPDATE',
      [run.executionId]
    );
    if (!execution.rowCount) throw new Error('Workflow execution not found');
    if (['completed', 'cancelled'].includes(execution.rows[0].status)) {
      return { executionStatus: execution.rows[0].status };
    }
    await client.query(
      `UPDATE workflow_executions
       SET status=$2,ended_at=NOW(),error_code=$3,error_message=$4,updated_at=NOW()
       WHERE id=$1`,
      [run.executionId, terminalStatus, run.errorCode || null, run.errorMessage || null]
    );
    return { executionStatus: terminalStatus };
  });
}

export async function resumeWorkflowExecution(
  executionId: string,
  actorUserId: string,
  retry: WorkflowRetrySnapshot
): Promise<{ runId: string; status: string }> {
  return withTransaction(async (client) => {
    const executionResult = await client.query<QueryResultRow>(
      'SELECT * FROM workflow_executions WHERE id=$1 FOR UPDATE',
      [executionId]
    );
    if (!executionResult.rowCount) throw new Error('WORKFLOW_EXECUTION_NOT_FOUND');
    if (!['failed', 'needs_review'].includes(executionResult.rows[0].status)) {
      throw new Error('WORKFLOW_EXECUTION_NOT_RESUMABLE');
    }
    const previousResult = await client.query<QueryResultRow>(
      `SELECT * FROM workflow_runs WHERE execution_id=$1 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
      [executionId]
    );
    if (!previousResult.rowCount) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const previous = previousResult.rows[0];
    if (previous.uncertain_write) throw new Error('WORKFLOW_UNCERTAIN_WRITE_REVIEW_REQUIRED');
    if (
      previous.workspace_id !== retry.workspaceId
      || previous.workflow_id !== retry.workflowId
      || previous.workflow_session_id !== retry.workflowSessionId
      || previous.message_id !== retry.messageId
    ) {
      throw new Error('WORKFLOW_RETRY_SNAPSHOT_MISMATCH');
    }
    const attempt = Number(previous.attempt_number) + 1;
    const runId = randomUUID();
    const idempotencyKey = `${executionId}:${retry.promptDigest}:${retry.bindingDigest}:entry:${attempt}`;
    const status = retry.compiledAccessScope.approvalGates.length > 0
      ? 'waiting_for_approval'
      : 'queued';
    await client.query(
      `INSERT INTO workflow_runs (
         id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,
         attempt_number,agent_id,agent_version,agent_snapshot,target_id,target_type,
         idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
         llm_reasoning_summary_mode,llm_reasoning_effort,prompt_text,prompt_digest,binding_digest,
         resource_bindings,resolved_at,requested_at
       ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())`,
      [
        runId,
        executionId,
        retry.workspaceId,
        retry.workflowId,
        retry.workflowSessionId,
        attempt,
        retry.agentId,
        retry.agentVersion,
        retry.agentSnapshot,
        retry.targetId || null,
        retry.targetType || null,
        idempotencyKey,
        retry.messageId,
        actorUserId,
        status,
        retry.compiledAccessScope,
        previous.llm_provider,
        previous.llm_model,
        previous.llm_reasoning_summary_mode,
        previous.llm_reasoning_effort,
        retry.prompt,
        retry.promptDigest,
        retry.bindingDigest,
        JSON.stringify(retry.resourceBindings),
        retry.resolvedAt
      ]
    );
    for (const [index, gate] of retry.compiledAccessScope.approvalGates.entries()) {
      await client.query(
        `INSERT INTO workflow_approvals (
           id,run_id,workspace_id,workflow_id,workflow_run_id,workflow_session_id,
           tool_call_id,tool_name,summary,arguments,status,execution_status,requested_by,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'workflow.approval_gate',$8,$9,'pending','not_started',$10,NOW()+INTERVAL '15 minutes')`,
        [randomUUID(), runId, retry.workspaceId, retry.workflowId, executionId, retry.workflowSessionId,
         `workflow-gate-${index + 1}`, gate,
         { executionId, workflowId: retry.workflowId, attemptNumber: attempt }, actorUserId]
      );
    }
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), retry.workspaceId, executionId, runId, idempotencyKey, { runId, executionId, workflowId: retry.workflowId }]
    );
    await client.query(
      `UPDATE workflow_executions SET status=$2,error_code=NULL,error_message=NULL,ended_at=NULL,updated_at=NOW() WHERE id=$1`,
      [executionId, status]
    );
    return { runId, status };
  });
}
