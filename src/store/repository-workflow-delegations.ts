import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { CompiledAgentRunScope } from '../types/agents.js';
import type { TargetType } from '../types/domain.js';
import { withTransaction } from './repository-transaction.js';

export interface WorkflowDelegationRecord {
  id: string;
  workspaceId: string;
  parentExecutionId: string;
  childRunId?: string;
  capabilityId: string;
  targetBinding: { id: string; targetType: TargetType };
  taskPrompt: string;
  required: boolean;
  selectedAgentId: string;
  selectedAgentVersion: number;
  compiledScope: CompiledAgentRunScope;
  status: 'queued' | 'dispatching' | 'running' | 'waiting_for_approval' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

type Row = QueryResultRow;
const iso = (value: unknown): string => new Date(value as string).toISOString();

function map(row: Row): WorkflowDelegationRecord {
  const childStatus = row.child_status as WorkflowDelegationRecord['status'] | undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentExecutionId: row.parent_execution_id,
    childRunId: row.child_run_id || undefined,
    capabilityId: row.capability_id,
    targetBinding: row.target_binding,
    taskPrompt: row.task_prompt,
    required: row.required,
    selectedAgentId: row.selected_agent_id,
    selectedAgentVersion: row.selected_agent_version,
    compiledScope: row.compiled_scope,
    status: childStatus || row.status,
    result: row.child_assistant_message || row.result || undefined,
    errorCode: row.child_error_code || row.error_code || undefined,
    errorMessage: row.child_error_message || row.error_message || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function reserveWorkflowDelegation(input: {
  workspaceId: string;
  parentExecutionId: string;
  capabilityId: string;
  targetBinding: WorkflowDelegationRecord['targetBinding'];
  taskPrompt: string;
  required: boolean;
  selectedAgentId: string;
  selectedAgentVersion: number;
  compiledScope: CompiledAgentRunScope;
  maxConcurrentChildren: number;
  maxChildren: number;
}): Promise<WorkflowDelegationRecord> {
  return withTransaction(async (client) => {
    const parent = await client.query(
      'SELECT id FROM workflow_executions WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [input.parentExecutionId, input.workspaceId]
    );
    if (!parent.rowCount) throw new Error('DELEGATION_PARENT_NOT_FOUND');
    const counts = await client.query<{ total: string; active: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status IN ('queued','running'))::text AS active
       FROM workflow_delegations WHERE parent_execution_id=$1`,
      [input.parentExecutionId]
    );
    if (Number(counts.rows[0].total) >= input.maxChildren) throw new Error('DELEGATION_TOTAL_LIMIT');
    if (Number(counts.rows[0].active) >= input.maxConcurrentChildren) throw new Error('DELEGATION_CONCURRENCY_LIMIT');
    const result = await client.query<Row>(
      `INSERT INTO workflow_delegations (
         id,workspace_id,parent_execution_id,capability_id,target_binding,task_prompt,required,
         selected_agent_id,selected_agent_version,compiled_scope,status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') RETURNING *`,
      [randomUUID(), input.workspaceId, input.parentExecutionId, input.capabilityId,
       input.targetBinding, input.taskPrompt, input.required, input.selectedAgentId,
       input.selectedAgentVersion, input.compiledScope]
    );
    return map(result.rows[0]);
  });
}

export async function attachDelegationChild(delegationId: string, childRunId: string): Promise<void> {
  await db.query(
    `UPDATE workflow_delegations SET child_run_id=$2,status='running',updated_at=NOW() WHERE id=$1`,
    [delegationId, childRunId]
  );
}

export async function failWorkflowDelegation(delegationId: string, code: string, message: string): Promise<void> {
  await db.query(
    `UPDATE workflow_delegations SET status='failed',error_code=$2,error_message=$3,updated_at=NOW() WHERE id=$1`,
    [delegationId, code, message.slice(0, 500)]
  );
}

export async function listWorkflowDelegations(parentExecutionId: string): Promise<WorkflowDelegationRecord[]> {
  const result = await db.query<Row>(
    `SELECT delegation.*, activity.status AS child_status,
            activity.assistant_message AS child_assistant_message,
            activity.error_code AS child_error_code,
            activity.error_message AS child_error_message
     FROM workflow_delegations delegation
     LEFT JOIN agent_activity activity ON activity.id=delegation.child_run_id
     WHERE delegation.parent_execution_id=$1
     ORDER BY delegation.created_at,delegation.id`,
    [parentExecutionId]
  );
  return result.rows.map(map);
}

export async function workflowDelegationCompletionGate(parentExecutionId: string): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  const delegations = await listWorkflowDelegations(parentExecutionId);
  const required = delegations.filter((item) => item.required);
  if (required.some((item) => ['queued', 'dispatching', 'running', 'waiting_for_approval'].includes(item.status))) {
    return { allowed: false, reason: 'Required specialist delegations are still running.' };
  }
  if (required.length > 0 && !required.some((item) => item.status === 'completed')) {
    return { allowed: false, reason: 'No required specialist delegation completed successfully.' };
  }
  return { allowed: true };
}
