import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { withTransaction } from '../store/repository-transaction.js';
import type { WorkflowRunRecord } from '../store/repository-workflows.js';
import type { CompiledWorkflowAccessScope, WorkflowDefinitionForAccess, WorkflowStepDefinition } from '../types/workflows.js';
import { workflowToolOperation } from './workflow-access.js';

type Artifact = { id: string; type: string; title: string };

function stepScope(
  base: CompiledWorkflowAccessScope,
  workflow: WorkflowDefinitionForAccess,
  step: WorkflowStepDefinition,
  agentId: string,
  agentVersion: number
): CompiledWorkflowAccessScope {
  const tools = step.allowedTools.length ? step.allowedTools : base.tools;
  const mcpServers = step.allowedMcpServers.length ? step.allowedMcpServers : base.mcpServers;
  const operations: CompiledWorkflowAccessScope['toolOperations'] = Object.fromEntries(
    tools.map((tool) => [tool, workflowToolOperation(tool, workflow.policy.mode)])
  );
  const approvalGates = step.approvalRequired ? [`Approve workflow step: ${step.title}`] : [];
  return {
    ...base,
    mcpServers,
    tools,
    toolOperations: operations,
    enabledSkills: step.enabledSkills,
    contextGrants: step.contextGrants,
    approvalGates,
    jwtClaims: {
      ...base.jwtClaims,
      agent_id: agentId,
      agent_version: agentVersion,
      permissions: {
        allowed_tools: tools,
        allowed_tool_operations: operations,
        context_grants: step.contextGrants
      }
    }
  };
}

export async function advanceWorkflowExecution(
  run: WorkflowRunRecord,
  terminalStatus: 'completed'|'failed'|'cancelled',
  artifacts: Artifact[] = []
): Promise<{ executionStatus: string; nextRunId?: string }> {
  return withTransaction(async (client) => {
    const executionResult = await client.query<QueryResultRow>(
      'SELECT * FROM workflow_executions WHERE id=$1 FOR UPDATE', [run.executionId]
    );
    if (!executionResult.rowCount) throw new Error('Workflow execution not found');
    const execution = executionResult.rows[0];
    if (['completed','cancelled'].includes(execution.status)) return { executionStatus: execution.status };
    if (terminalStatus !== 'completed') {
      await client.query(
        `UPDATE workflow_executions SET status=$2,ended_at=NOW(),error_code=$3,error_message=$4,updated_at=NOW() WHERE id=$1`,
        [run.executionId, terminalStatus, run.errorCode || null, run.errorMessage || null]
      );
      return { executionStatus: terminalStatus };
    }
    const workflow = execution.workflow_snapshot as WorkflowDefinitionForAccess;
    const completedStep = workflow.steps[run.stepIndex];
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
    const missing = (completedStep?.outputArtifacts || []).filter((artifact) => artifact.required && !artifactIds.has(artifact.id));
    if (missing.length) {
      const message = `Required workflow outputs were not produced: ${missing.map((item) => item.id).join(', ')}`;
      await client.query(
        `UPDATE workflow_runs SET status='failed',error_code='REQUIRED_OUTPUT_MISSING',error_message=$2,ended_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [run.id, message]
      );
      await client.query(
        `UPDATE workflow_executions SET status='failed',error_code='REQUIRED_OUTPUT_MISSING',error_message=$2,ended_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [run.executionId, message]
      );
      return { executionStatus: 'failed' };
    }
    const nextStepIndex = run.stepIndex + 1;
    const nextStep = workflow.steps[nextStepIndex];
    if (!nextStep) {
      await client.query("UPDATE workflow_executions SET status='completed',ended_at=NOW(),updated_at=NOW() WHERE id=$1", [run.executionId]);
      return { executionStatus: 'completed' };
    }
    if (nextStep.agentIds?.length !== 1) throw new Error(`Workflow step ${nextStep.id} must select exactly one Agent`);
    const agentId = nextStep.agentIds[0];
    const agentResult = await client.query<QueryResultRow>(
      `SELECT * FROM agent_definitions WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE`,
      [run.workspaceId, agentId]
    );
    if (!agentResult.rowCount) throw new Error(`Workflow Agent ${agentId} is not active`);
    const agent = agentResult.rows[0];
    const sessionResult = await client.query<QueryResultRow>('SELECT compiled_access_scope FROM workflow_sessions WHERE id=$1', [run.workflowSessionId]);
    const scope = stepScope(sessionResult.rows[0].compiled_access_scope, workflow, nextStep, agentId, agent.version);
    const nextRunId = randomUUID();
    const idempotencyKey = `${run.executionId}:${nextStepIndex}:1`;
    const status = scope.approvalGates.length ? 'waiting_for_approval' : 'queued';
    await client.query(
      `INSERT INTO workflow_runs (
        id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,workflow_step_id,
        step_index,attempt_number,agent_id,agent_version,agent_snapshot,step_snapshot,step_scope,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,requested_at
       ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$12,$19,$20,$21,$22,NOW())`,
      [nextRunId, run.executionId, run.workspaceId, run.workflowId, run.workflowSessionId, nextStep.id,
       nextStepIndex, agentId, agent.version, agent, nextStep, scope, run.targetId || null, run.targetType || null,
       idempotencyKey, run.messageId, run.createdBy, status, run.llmProvider || null, run.llmModel || null,
       run.llmReasoningSummaryMode || null, run.llmReasoningEffort || null]
    );
    for (const [index, gate] of scope.approvalGates.entries()) {
      await client.query(
        `INSERT INTO workflow_approvals (
          id,run_id,workspace_id,workflow_id,workflow_run_id,workflow_session_id,workflow_step_id,
          tool_call_id,tool_name,summary,arguments,status,execution_status,requested_by,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'workflow.approval_gate',$9,$10,'pending','not_started',$11,NOW()+INTERVAL '15 minutes')`,
        [randomUUID(), nextRunId, run.workspaceId, run.workflowId, run.executionId, run.workflowSessionId,
         nextStep.id, `workflow-gate-${index + 1}`, gate,
         { executionId: run.executionId, workflowStepId: nextStep.id }, run.createdBy]
      );
    }
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), run.workspaceId, run.executionId, nextRunId, idempotencyKey,
       { runId: nextRunId, executionId: run.executionId, workflowId: run.workflowId, stepIndex: nextStepIndex }]
    );
    await client.query(
      `UPDATE workflow_executions SET status=$2,current_step_index=$3,started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1`,
      [run.executionId, status, nextStepIndex]
    );
    return { executionStatus: status, nextRunId };
  });
}

export async function resumeWorkflowExecution(executionId: string, actorUserId: string): Promise<{ runId: string; status: string }> {
  return withTransaction(async (client) => {
    const executionResult = await client.query<QueryResultRow>(
      'SELECT * FROM workflow_executions WHERE id=$1 FOR UPDATE', [executionId]
    );
    if (!executionResult.rowCount) throw new Error('WORKFLOW_EXECUTION_NOT_FOUND');
    const execution = executionResult.rows[0];
    if (!['failed','needs_review'].includes(execution.status)) throw new Error('WORKFLOW_EXECUTION_NOT_RESUMABLE');
    const priorResult = await client.query<QueryResultRow>(
      `SELECT * FROM workflow_runs WHERE execution_id=$1 AND step_index=$2 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
      [executionId, execution.current_step_index]
    );
    if (!priorResult.rowCount) throw new Error('WORKFLOW_EXECUTION_ATTEMPT_NOT_FOUND');
    const prior = priorResult.rows[0];
    const attempt = prior.attempt_number + 1;
    const runId = randomUUID();
    const idempotencyKey = `${executionId}:${prior.step_index}:${attempt}`;
    const approvalGates: string[] = prior.step_scope?.approvalGates || [];
    const status = approvalGates.length ? 'waiting_for_approval' : 'queued';
    await client.query(
      `INSERT INTO workflow_runs (
        id,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,workflow_step_id,
        step_index,attempt_number,agent_id,agent_version,agent_snapshot,step_snapshot,step_scope,target_id,target_type,
        idempotency_key,message_id,created_by,status,compiled_access_scope,llm_provider,llm_model,
        llm_reasoning_summary_mode,llm_reasoning_effort,requested_at
       ) SELECT $2,workflow_run_id,execution_id,workspace_id,workflow_id,workflow_session_id,workflow_step_id,
         step_index,$3,agent_id,agent_version,agent_snapshot,step_snapshot,step_scope,target_id,target_type,
         $4,message_id,$5,$6,compiled_access_scope,llm_provider,llm_model,llm_reasoning_summary_mode,llm_reasoning_effort,NOW()
       FROM workflow_runs WHERE id=$1`, [prior.id, runId, attempt, idempotencyKey, actorUserId, status]
    );
    for (const [index, gate] of approvalGates.entries()) {
      await client.query(
        `INSERT INTO workflow_approvals (
          id,run_id,workspace_id,workflow_id,workflow_run_id,workflow_session_id,workflow_step_id,
          tool_call_id,tool_name,summary,arguments,status,execution_status,requested_by,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'workflow.approval_gate',$9,$10,'pending','not_started',$11,NOW()+INTERVAL '15 minutes')`,
        [randomUUID(), runId, execution.workspace_id, execution.workflow_id, executionId,
         execution.workflow_session_id, prior.workflow_step_id, `workflow-gate-${index + 1}`, gate,
         { executionId, workflowStepId: prior.workflow_step_id, resumeAttempt: attempt }, actorUserId]
      );
    }
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'workflow',$3,$4,$5,$6)`,
      [randomUUID(), execution.workspace_id, executionId, runId, idempotencyKey,
       { runId, executionId, workflowId: execution.workflow_id, stepIndex: prior.step_index, attempt }]
    );
    await client.query(
      `UPDATE workflow_executions SET status=$2,error_code=NULL,error_message=NULL,ended_at=NULL,updated_at=NOW() WHERE id=$1`,
      [executionId, status]
    );
    return { runId, status };
  });
}
