import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import { withTransaction } from '../store/repository-transaction.js';

type Artifact = { id: string; type: string; title: string };

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
  actorUserId: string
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
    const attempt = Number(previous.attempt_number) + 1;
    const runId = randomUUID();
    const idempotencyKey = `${executionId}:entry:${attempt}`;
    await client.query(
      `INSERT INTO workflow_runs (
         id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,
         attempt_number,agent_id,agent_version,agent_snapshot,target_id,target_type,
         idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
         llm_reasoning_summary_mode,llm_reasoning_effort,requested_at
       ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$16,$17,$18,$19,NOW())`,
      [
        runId,
        executionId,
        previous.workspace_id,
        previous.workflow_id,
        previous.workflow_session_id,
        attempt,
        previous.agent_id,
        previous.agent_version,
        previous.agent_snapshot,
        previous.target_id,
        previous.target_type,
        idempotencyKey,
        previous.message_id,
        actorUserId,
        previous.compiled_access_scope,
        previous.llm_provider,
        previous.llm_model,
        previous.llm_reasoning_summary_mode,
        previous.llm_reasoning_effort
      ]
    );
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), previous.workspace_id, executionId, runId, idempotencyKey, { runId, executionId, workflowId: previous.workflow_id }]
    );
    await client.query(
      `UPDATE workflow_executions SET status='queued',error_code=NULL,error_message=NULL,ended_at=NULL,updated_at=NOW() WHERE id=$1`,
      [executionId]
    );
    return { runId, status: 'queued' };
  });
}
