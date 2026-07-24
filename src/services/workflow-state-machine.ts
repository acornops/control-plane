import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import { withTransaction } from '../store/repository-transaction.js';
import type { TargetType } from '../types/domain.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import type { CompiledWorkflowAccessScope } from '../types/workflows.js';
import type { AgentDefinition } from '../types/agents.js';
import { insertWorkflowExecutionEvent } from '../store/repository-workflow-execution-events.js';
import { WORKFLOW_COORDINATOR_INSTRUCTIONS, WORKFLOW_COORDINATOR_PROFILE_VERSION } from './workflow-coordinator.js';

type Artifact = { id: string; type: string; title: string };

export interface WorkflowRetrySnapshot {
  workspaceId: string;
  workflowId: string;
  workflowSessionId: string;
  messageId: string;
  executorRole: 'coordinator' | 'specialist';
  specialistSnapshot?: AgentDefinition;
  targetId?: string;
  targetType?: TargetType;
  compiledAccessScope: CompiledWorkflowAccessScope;
  prompt: string;
  promptDigest: string;
  bindingDigest: string;
  resourceBindings: PromptResourceBinding[];
  resolvedAt: string;
}

export async function advanceWorkflowExecution(
  run: WorkflowRunRecord,
  terminalStatus: 'completed' | 'failed' | 'cancelled',
  _artifacts: Artifact[] = []
): Promise<{ executionStatus: string; cancelledChildRunIds?: string[] }> {
  if (run.parentRunId) return { executionStatus: 'running' };
  return withTransaction(async (client) => {
    const execution = await client.query<QueryResultRow>(
      'SELECT status FROM workflow_executions WHERE id=$1 FOR UPDATE',
      [run.executionId]
    );
    if (!execution.rowCount) throw new Error('Workflow execution not found');
    if (['completed', 'failed', 'cancelled'].includes(execution.rows[0].status)) {
      return { executionStatus: execution.rows[0].status };
    }
    const activeChildren = await client.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE parent_run_id=$1 AND status NOT IN ('completed','failed','cancelled')
       FOR UPDATE`,
      [run.id]
    );
    const cancelledChildRunIds = activeChildren.rows.map((child) => child.id);
    if (cancelledChildRunIds.length > 0) {
      await client.query(
        `UPDATE workflow_runs
         SET status='cancelled',cancellation_requested_at=NOW(),ended_at=NOW(),
             error_code='PARENT_RUN_TERMINATED',
             error_message='The coordinator root terminated before this specialist completed.',
             updated_at=NOW()
         WHERE id=ANY($1::text[])`,
        [cancelledChildRunIds]
      );
      await client.query(
        `UPDATE workflow_run_approvals
         SET status='expired'
         WHERE run_id=ANY($1::text[]) AND status='pending'`,
        [cancelledChildRunIds]
      );
      await client.query(
        'DELETE FROM workflow_run_continuations WHERE run_id=ANY($1::text[])',
        [cancelledChildRunIds]
      );
      await client.query(
        `UPDATE automation_dispatch_outbox
         SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE run_id=ANY($1::text[]) AND status<>'delivered'`,
        [cancelledChildRunIds]
      );
    }
    await client.query(
      `UPDATE workflow_executions
       SET status=$2,ended_at=NOW(),error_code=$3,error_message=$4,updated_at=NOW()
       WHERE id=$1`,
      [run.executionId, terminalStatus, run.errorCode || null, run.errorMessage || null]
    );
    return { executionStatus: terminalStatus, cancelledChildRunIds };
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
      `SELECT * FROM workflow_runs WHERE execution_id=$1 AND parent_run_id IS NULL ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
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
    const idempotencyKey = `${executionId}:${retry.promptDigest}:${retry.bindingDigest}:root:${attempt}`;
    const status = retry.compiledAccessScope.approvalGates.length > 0
      ? 'waiting_for_approval'
      : 'queued';
    const executor = retry.compiledAccessScope.executor;
    const compiledAccessScope = executor.role === 'coordinator'
      ? {
          ...retry.compiledAccessScope,
          executor: {
            role: 'coordinator' as const,
            profileVersion: WORKFLOW_COORDINATOR_PROFILE_VERSION
          }
        }
      : retry.compiledAccessScope;
    const executorSnapshot = executor.role === 'coordinator'
      ? { role: 'coordinator', profileVersion: WORKFLOW_COORDINATOR_PROFILE_VERSION, instructions: WORKFLOW_COORDINATOR_INSTRUCTIONS }
      : {
          role: 'specialist',
          agentId: executor.agentId,
          agentVersion: executor.agentVersion,
          agent: retry.specialistSnapshot || (() => { throw new Error('SPECIALIST_EXECUTOR_SNAPSHOT_REQUIRED'); })()
        };
    await client.query(
      `INSERT INTO workflow_runs (
         id,execution_id,workspace_id,workflow_id,workflow_session_id,
         attempt_number,executor_role,agent_id,agent_version,executor_snapshot,target_id,target_type,
         idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
         llm_reasoning_summary_mode,llm_reasoning_effort,prompt_text,prompt_digest,binding_digest,
         resource_bindings,resolved_at,requested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())`,
      [
        runId,
        executionId,
        retry.workspaceId,
        retry.workflowId,
        retry.workflowSessionId,
        attempt,
        executor.role,
        executor.role === 'specialist' ? executor.agentId : null,
        executor.role === 'specialist' ? executor.agentVersion : null,
        executorSnapshot,
        retry.targetId || null,
        retry.targetType || null,
        idempotencyKey,
        retry.messageId,
        actorUserId,
        status,
        compiledAccessScope,
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
    const approvals: Array<{
      id: string;
      tool_name: string;
      summary: string;
      status: string;
      expires_at: string;
    }> = [];
    for (const [index, gate] of retry.compiledAccessScope.approvalGates.entries()) {
      const approval = await client.query<{
        id: string;
        tool_name: string;
        summary: string;
        status: string;
        expires_at: string;
      }>(
        `INSERT INTO workflow_run_approvals (
           id,run_id,workspace_id,approval_kind,tool_call_id,tool_name,summary,arguments,
           status,execution_status,requested_by,expires_at
         ) VALUES ($1,$2,$3,'pre_step',$4,'workflow.approval_gate',$5,$6,'pending','not_started',$7,NOW()+INTERVAL '15 minutes')
         RETURNING id,tool_name,summary,status,expires_at`,
        [randomUUID(), runId, retry.workspaceId, `workflow-gate-${index + 1}`, gate,
         { executionId, workflowId: retry.workflowId, attemptNumber: attempt }, actorUserId]
      );
      approvals.push(approval.rows[0]);
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
    await insertWorkflowExecutionEvent(client, {
      executionId,
      workspaceId: retry.workspaceId,
      type: 'run_created',
      runId,
      dedupeKey: `run-created:${runId}`,
      payload: {
        executorRole: executor.role,
        parentRunId: null,
        agentId: executor.role === 'specialist' ? executor.agentId : null,
        attemptNumber: attempt,
        status,
        targetId: retry.targetId || null,
        targetType: retry.targetType || null
      }
    });
    for (const approval of approvals) {
      await insertWorkflowExecutionEvent(client, {
        executionId,
        workspaceId: retry.workspaceId,
        type: 'approval_requested',
        runId,
        approvalId: approval.id,
        dedupeKey: `approval-requested:${approval.id}`,
        payload: {
          approvalKind: 'pre_step',
          toolName: approval.tool_name,
          summary: approval.summary,
          status: approval.status,
          expiresAt: new Date(approval.expires_at).toISOString()
        }
      });
    }
    return { runId, status };
  });
}
