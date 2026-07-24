import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { ToolApprovalStatus } from '../types/domain.js';
import { decideWorkflowApprovalRow } from './repository-approval-decisions.js';
import type { WorkflowRunRecord } from './repository-workflow-runs.js';

type Row = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

export interface WorkflowApprovalRecord {
  id: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  executionId: string;
  workflowSessionId: string;
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

function mapApproval(row: Row): WorkflowApprovalRecord {
  return {
    id: row.id, runId: row.run_id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    executionId: row.execution_id, workflowSessionId: row.workflow_session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name, summary: row.summary, arguments: row.arguments || {}, status: row.status,
    executionStatus: row.execution_status, requestedBy: row.requested_by || undefined,
    decidedBy: row.decided_by || undefined, decision: row.decision || undefined,
    createdAt: iso(row.created_at)!, decidedAt: iso(row.decided_at), expiresAt: iso(row.expires_at)!
  };
}

export async function insertWorkflowRunApprovals(
  client: PoolClient,
  run: WorkflowRunRecord,
  approvalGates: string[]
): Promise<WorkflowApprovalRecord[]> {
  const approvals: WorkflowApprovalRecord[] = [];
  for (const [index, gate] of approvalGates.entries()) {
    const result = await client.query<Row>(
      `WITH inserted AS (
         INSERT INTO workflow_run_approvals (
           id,run_id,workspace_id,approval_kind,tool_call_id,tool_name,summary,arguments,
           status,execution_status,requested_by,expires_at
         ) VALUES ($1,$2,$3,'pre_step',$4,'workflow.approval_gate',$5,$6,'pending','not_started',$7,NOW()+INTERVAL '15 minutes')
         RETURNING *
       )
       SELECT inserted.*, run.execution_id, run.workflow_id, run.workflow_session_id
       FROM inserted JOIN workflow_runs run ON run.id=inserted.run_id`,
      [randomUUID(), run.id, run.workspaceId, `workflow-gate-${index + 1}`, gate,
       { executionId: run.executionId, workflowId: run.workflowId }, run.createdBy]
    );
    approvals.push(mapApproval(result.rows[0]));
  }
  return approvals;
}

export async function listWorkflowRunApprovals(runId: string): Promise<WorkflowApprovalRecord[]> {
  const result = await db.query<Row>(
    `SELECT approval.*,run.execution_id,run.workflow_id,run.workflow_session_id
     FROM workflow_run_approvals approval
     JOIN workflow_runs run ON run.id=approval.run_id
     WHERE approval.run_id=$1 ORDER BY approval.created_at,approval.id`,
    [runId]
  );
  return result.rows.map(mapApproval);
}

export async function listWorkflowApprovalsForWorkspace(
  workspaceId: string,
  status: 'pending' | 'decided' | 'all' = 'pending'
): Promise<WorkflowApprovalRecord[]> {
  const clause = status === 'all' ? '' : status === 'pending' ? "AND status='pending'" : "AND status<>'pending'";
  const result = await db.query<Row>(
    `SELECT approval.*,run.execution_id,run.workflow_id,run.workflow_session_id
     FROM workflow_run_approvals approval
     JOIN workflow_runs run ON run.id=approval.run_id
     WHERE approval.workspace_id=$1 ${clause.replaceAll('status', 'approval.status')}
     ORDER BY approval.created_at DESC,approval.id DESC`,
    [workspaceId]
  );
  return result.rows.map(mapApproval);
}

export async function getWorkflowRunApproval(approvalId: string): Promise<WorkflowApprovalRecord | null> {
  const result = await db.query<Row>(
    `SELECT approval.*,run.execution_id,run.workflow_id,run.workflow_session_id
     FROM workflow_run_approvals approval
     JOIN workflow_runs run ON run.id=approval.run_id
     WHERE approval.id=$1`,
    [approvalId]
  );
  return result.rowCount ? mapApproval(result.rows[0]) : null;
}

export async function decideWorkflowRunApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<WorkflowApprovalRecord | null> {
  return (await decideWorkflowRunApprovalOutcome(approvalId, decision, decidedBy))?.approval || null;
}

export interface WorkflowApprovalDecisionOutcome {
  approval: WorkflowApprovalRecord;
  transitioned: boolean;
}

export async function decideWorkflowRunApprovalOutcome(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<WorkflowApprovalDecisionOutcome | null> {
  const outcome = await decideWorkflowApprovalRow(approvalId, decision, decidedBy);
  return outcome ? {
    approval: mapApproval(outcome.row),
    transitioned: outcome.transitioned
  } : null;
}
