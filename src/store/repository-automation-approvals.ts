import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { withTransaction } from './repository-transaction.js';

export type AutomationApprovalSource = 'agent' | 'workflow';
export type AutomationApprovalKind = 'pre_step' | 'tool_write';
export type AutomationApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type AutomationApprovalExecutionStatus = 'not_started' | 'executing' | 'succeeded' | 'failed' | 'unknown';

export interface AutomationRunApproval {
  id: string;
  workspaceId: string;
  sourceType: AutomationApprovalSource;
  sourceId: string;
  runId: string;
  targetId?: string;
  targetType?: string;
  approvalKind: AutomationApprovalKind;
  toolCallId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
  status: AutomationApprovalStatus;
  executionStatus: AutomationApprovalExecutionStatus;
  executionStartedAt?: string;
  executionFinishedAt?: string;
  toolResult?: unknown;
  toolResultIsError?: boolean;
  requestedBy?: string;
  decidedBy?: string;
  decision?: 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

export interface AutomationRunContinuation {
  sourceType: AutomationApprovalSource;
  runId: string;
  approvalId: string;
  schemaVersion: number;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomationRunApprovalInput {
  workspaceId: string;
  sourceType: AutomationApprovalSource;
  sourceId: string;
  runId: string;
  targetId?: string;
  targetType?: string;
  approvalKind: AutomationApprovalKind;
  toolCallId: string;
  toolName: string;
  summary: string;
  arguments?: Record<string, unknown>;
  requestedBy?: string;
  expiresAt: string;
  continuationState?: Record<string, unknown>;
}

const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapApproval(row: QueryResultRow): AutomationRunApproval {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    runId: row.run_id,
    targetId: row.target_id || undefined,
    targetType: row.target_type || undefined,
    approvalKind: row.approval_kind,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    summary: row.summary,
    arguments: row.arguments || {},
    status: row.status,
    executionStatus: row.execution_status,
    executionStartedAt: iso(row.execution_started_at),
    executionFinishedAt: iso(row.execution_finished_at),
    toolResult: row.tool_result ?? undefined,
    toolResultIsError: row.tool_result_is_error ?? undefined,
    requestedBy: row.requested_by || undefined,
    decidedBy: row.decided_by || undefined,
    decision: row.decision || undefined,
    createdAt: iso(row.created_at)!,
    decidedAt: iso(row.decided_at),
    expiresAt: iso(row.expires_at)!
  };
}

function mapContinuation(row: QueryResultRow): AutomationRunContinuation {
  return {
    sourceType: row.source_type,
    runId: row.run_id,
    approvalId: row.approval_id,
    schemaVersion: row.schema_version,
    state: row.state || {},
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

async function setWaitingForApproval(client: PoolClient, sourceType: AutomationApprovalSource, runId: string): Promise<void> {
  if (sourceType === 'agent') {
    await client.query(
      `UPDATE agent_activity SET status='waiting_for_approval',updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('completed','failed','cancelled','needs_review')`,
      [runId]
    );
    return;
  }
  await client.query(
    `UPDATE workflow_runs SET status='waiting_for_approval',updated_at=NOW()
     WHERE id=$1 AND status NOT IN ('completed','failed','cancelled','needs_review')`,
    [runId]
  );
  await client.query(
    `UPDATE workflow_executions execution SET status='waiting_for_approval',updated_at=NOW()
     FROM workflow_runs run WHERE run.id=$1 AND execution.id=run.execution_id
       AND execution.status NOT IN ('completed','failed','cancelled','needs_review')`,
    [runId]
  );
}

async function markNeedsReview(client: PoolClient, approval: AutomationRunApproval): Promise<void> {
  const message = 'A write may have executed, so this run requires authorized review before resume.';
  if (approval.sourceType === 'agent') {
    await client.query(
      `UPDATE agent_activity SET status='needs_review',error_code='UNCERTAIN_WRITE_RESULT',error_message=$2,updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
      [approval.runId, message]
    );
    return;
  }
  await client.query(
    `UPDATE workflow_runs SET status='needs_review',uncertain_write=true,error_code='UNCERTAIN_WRITE_RESULT',
       error_message=$2,updated_at=NOW() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
    [approval.runId, message]
  );
  await client.query(
    `UPDATE workflow_executions execution SET status='needs_review',error_code='UNCERTAIN_WRITE_RESULT',
       error_message=$2,updated_at=NOW() FROM workflow_runs run
     WHERE run.id=$1 AND execution.id=run.execution_id AND execution.status NOT IN ('completed','failed','cancelled')`,
    [approval.runId, message]
  );
}

export async function insertAutomationRunApproval(
  client: PoolClient,
  input: CreateAutomationRunApprovalInput
): Promise<AutomationRunApproval> {
  const result = await client.query<QueryResultRow>(
    `INSERT INTO automation_run_approvals (
       id,workspace_id,source_type,source_id,run_id,target_id,target_type,approval_kind,
       tool_call_id,tool_name,summary,arguments,requested_by,expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
     ON CONFLICT (source_type,run_id,tool_call_id) DO UPDATE SET
       tool_name=EXCLUDED.tool_name,
       summary=EXCLUDED.summary,
       arguments=EXCLUDED.arguments
     RETURNING *`,
    [randomUUID(), input.workspaceId, input.sourceType, input.sourceId, input.runId,
     input.targetId || null, input.targetType || null, input.approvalKind, input.toolCallId,
     input.toolName, input.summary, JSON.stringify(input.arguments || {}), input.requestedBy || null, input.expiresAt]
  );
  const approval = mapApproval(result.rows[0]);
  if (input.continuationState) {
    await client.query(
      `INSERT INTO automation_run_continuations (source_type,run_id,approval_id,state)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (source_type,run_id) DO UPDATE SET
         approval_id=EXCLUDED.approval_id,state=EXCLUDED.state,schema_version=1,updated_at=NOW()`,
      [input.sourceType, input.runId, approval.id, JSON.stringify(input.continuationState)]
    );
    await setWaitingForApproval(client, input.sourceType, input.runId);
  }
  await insertWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'approval',
    eventType: input.approvalKind === 'pre_step'
      ? `${input.sourceType}.pre_step_approval_requested.v1`
      : `${input.sourceType}.tool_approval_requested.v1`,
    operation: 'write',
    actorUserId: input.requestedBy || null,
    objectType: 'automation_approval',
    objectId: approval.id,
    objectName: approval.toolName,
    summary: input.approvalKind === 'pre_step' ? 'Automation pre-step approval requested' : 'Automation write-tool approval requested',
    metadata: {
      source: input.sourceType,
      sourceId: input.sourceId,
      runId: input.runId,
      approvalKind: input.approvalKind,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      expiresAt: input.expiresAt
    }
  }, client);
  return approval;
}

export async function createAutomationRunApproval(input: CreateAutomationRunApprovalInput): Promise<AutomationRunApproval> {
  return withTransaction((client) => insertAutomationRunApproval(client, input));
}

export async function getAutomationRunApproval(approvalId: string): Promise<AutomationRunApproval | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM automation_run_approvals WHERE id=$1', [approvalId]);
  return result.rowCount ? mapApproval(result.rows[0]) : null;
}

export async function listAutomationRunApprovals(
  sourceType: AutomationApprovalSource,
  runId: string
): Promise<AutomationRunApproval[]> {
  const result = await db.query<QueryResultRow>(
    'SELECT * FROM automation_run_approvals WHERE source_type=$1 AND run_id=$2 ORDER BY created_at,id',
    [sourceType, runId]
  );
  return result.rows.map(mapApproval);
}

export async function listWorkspaceAutomationApprovals(params: {
  workspaceId: string;
  status?: 'pending' | 'decided' | 'all';
  limit?: number;
  cursor?: string;
}): Promise<AutomationRunApproval[]> {
  const status = params.status || 'pending';
  const values: unknown[] = [params.workspaceId];
  const where = ['workspace_id=$1'];
  if (status === 'pending') where.push("status='pending'");
  else if (status === 'decided') where.push("status<>'pending'");
  if (params.cursor) {
    values.push(params.cursor);
    where.push(`created_at < $${values.length}::timestamptz`);
  }
  values.push(Math.max(1, Math.min(100, params.limit || 50)));
  const result = await db.query<QueryResultRow>(
    `SELECT * FROM automation_run_approvals WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapApproval);
}

export async function countPendingWorkspaceAutomationApprovals(workspaceId: string): Promise<number> {
  const result = await db.query<{ count: string | number }>(
    "SELECT COUNT(*) AS count FROM automation_run_approvals WHERE workspace_id=$1 AND status='pending'",
    [workspaceId]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function getAutomationRunContinuation(
  sourceType: AutomationApprovalSource,
  runId: string
): Promise<AutomationRunContinuation | null> {
  const result = await db.query<QueryResultRow>(
    'SELECT * FROM automation_run_continuations WHERE source_type=$1 AND run_id=$2',
    [sourceType, runId]
  );
  return result.rowCount ? mapContinuation(result.rows[0]) : null;
}

export async function deleteAutomationRunContinuation(sourceType: AutomationApprovalSource, runId: string): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM automation_run_continuations WHERE source_type=$1 AND run_id=$2',
    [sourceType, runId]
  );
  return (result.rowCount || 0) > 0;
}

export async function decideAutomationRunApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<AutomationRunApproval | null> {
  const status = decision === 'approved' ? 'approved' : 'rejected';
  const result = await db.query<QueryResultRow>(
    `UPDATE automation_run_approvals SET
       status=CASE WHEN status='pending' AND expires_at<=NOW() THEN 'expired'
                   WHEN status='pending' THEN $2 ELSE status END,
       decision=CASE WHEN status='pending' AND expires_at>NOW() THEN $3 ELSE decision END,
       decided_by=CASE WHEN status='pending' AND expires_at>NOW() THEN $4 ELSE decided_by END,
       decided_at=CASE WHEN status='pending' AND expires_at>NOW() THEN NOW() ELSE decided_at END
     WHERE id=$1 RETURNING *`,
    [approvalId, status, decision, decidedBy]
  );
  return result.rowCount ? mapApproval(result.rows[0]) : null;
}

export async function applyAutomationApprovalOutcome(approval: AutomationRunApproval): Promise<void> {
  await withTransaction(async (client) => {
    if (approval.approvalKind === 'pre_step') {
      if (approval.status === 'approved') {
        if (approval.sourceType === 'agent') {
          await client.query(
            "UPDATE agent_activity SET status='queued',updated_at=NOW() WHERE id=$1 AND status='waiting_for_approval'",
            [approval.runId]
          );
        } else {
          await client.query(
            "UPDATE workflow_runs SET status='queued',updated_at=NOW() WHERE id=$1 AND status='waiting_for_approval'",
            [approval.runId]
          );
          await client.query(
            `UPDATE workflow_executions execution SET status='queued',updated_at=NOW()
             FROM workflow_runs run WHERE run.id=$1 AND execution.id=run.execution_id
               AND execution.status='waiting_for_approval'`,
            [approval.runId]
          );
        }
        return;
      }
      const errorCode = approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REJECTED';
      const errorMessage = approval.status === 'expired'
        ? 'Pre-step approval expired before the run was dispatched.'
        : 'Pre-step approval was rejected.';
      if (approval.sourceType === 'agent') {
        await client.query(
          `UPDATE agent_activity SET status='failed',error_code=$2,error_message=$3,ended_at=NOW(),updated_at=NOW()
           WHERE id=$1 AND status='waiting_for_approval'`,
          [approval.runId, errorCode, errorMessage]
        );
      } else {
        await client.query(
          `UPDATE workflow_runs SET status='failed',error_code=$2,error_message=$3,ended_at=NOW(),updated_at=NOW()
           WHERE id=$1 AND status='waiting_for_approval'`,
          [approval.runId, errorCode, errorMessage]
        );
        await client.query(
          `UPDATE workflow_executions execution SET status='failed',error_code=$2,error_message=$3,ended_at=NOW(),updated_at=NOW()
           FROM workflow_runs run WHERE run.id=$1 AND execution.id=run.execution_id
             AND execution.status='waiting_for_approval'`,
          [approval.runId, errorCode, errorMessage]
        );
      }
      await client.query(
        `UPDATE automation_dispatch_outbox SET status='cancelled',claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW()
         WHERE source_type=$1 AND run_id=$2 AND status<>'delivered'`,
        [approval.sourceType, approval.runId]
      );
      return;
    }

    if (approval.executionStatus === 'unknown') return;
    if (approval.status === 'expired') {
      const errorMessage = 'Write-tool approval expired before the operation could run.';
      if (approval.sourceType === 'agent') {
        await client.query(
          `UPDATE agent_activity SET status='failed',error_code='APPROVAL_EXPIRED',error_message=$2,ended_at=NOW(),updated_at=NOW()
           WHERE id=$1 AND status='waiting_for_approval'`,
          [approval.runId, errorMessage]
        );
      } else {
        await client.query(
          `UPDATE workflow_runs SET status='failed',error_code='APPROVAL_EXPIRED',error_message=$2,ended_at=NOW(),updated_at=NOW()
           WHERE id=$1 AND status='waiting_for_approval'`,
          [approval.runId, errorMessage]
        );
        await client.query(
          `UPDATE workflow_executions execution SET status='failed',error_code='APPROVAL_EXPIRED',
             error_message=$2,ended_at=NOW(),updated_at=NOW()
           FROM workflow_runs run WHERE run.id=$1 AND execution.id=run.execution_id
             AND execution.status='waiting_for_approval'`,
          [approval.runId, errorMessage]
        );
      }
      return;
    }
    if (approval.status !== 'approved' && approval.status !== 'rejected') return;
    if (approval.sourceType === 'agent') {
      await client.query(
        "UPDATE agent_activity SET status='queued',updated_at=NOW() WHERE id=$1 AND status='waiting_for_approval'",
        [approval.runId]
      );
    } else {
      await client.query(
        "UPDATE workflow_runs SET status='queued',updated_at=NOW() WHERE id=$1 AND status='waiting_for_approval'",
        [approval.runId]
      );
      await client.query(
        `UPDATE workflow_executions execution SET status='queued',updated_at=NOW()
         FROM workflow_runs run WHERE run.id=$1 AND execution.id=run.execution_id
           AND execution.status='waiting_for_approval'`,
        [approval.runId]
      );
    }
    await client.query(
      `INSERT INTO automation_dispatch_outbox (
         id,workspace_id,source_type,source_id,run_id,idempotency_key,payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), approval.workspaceId, approval.sourceType, approval.sourceId, approval.runId,
       `${approval.sourceType}:${approval.runId}:approval:${approval.id}`,
       { runId: approval.runId, approvalId: approval.id, resume: true }]
    );
  });
}

export async function expirePendingAutomationRunApprovals(limit = 100): Promise<AutomationRunApproval[]> {
  return withTransaction(async (client) => {
    const result = await client.query<QueryResultRow>(
      `WITH candidates AS (
         SELECT id FROM automation_run_approvals
         WHERE status='pending' AND expires_at<=NOW()
         ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE automation_run_approvals approval SET status='expired'
       FROM candidates WHERE approval.id=candidates.id RETURNING approval.*`,
      [Math.max(1, Math.min(1000, limit))]
    );
    return result.rows.map(mapApproval);
  });
}

export async function expireAutomationRunApproval(approvalId: string): Promise<AutomationRunApproval | null> {
  const result = await db.query<QueryResultRow>(
    `UPDATE automation_run_approvals SET status='expired'
     WHERE id=$1 AND status='pending' RETURNING *`,
    [approvalId]
  );
  if (result.rowCount) return mapApproval(result.rows[0]);
  return getAutomationRunApproval(approvalId);
}

export async function markAutomationApprovalExecutionStarted(approvalId: string): Promise<AutomationRunApproval | null> {
  return withTransaction(async (client) => {
    const result = await client.query<QueryResultRow>(
      `UPDATE automation_run_approvals SET
         execution_status=CASE WHEN status<>'approved' THEN execution_status
           WHEN execution_status='not_started' THEN 'executing'
           WHEN execution_status='executing' THEN 'unknown'
           ELSE execution_status END,
         execution_started_at=CASE WHEN status='approved' THEN COALESCE(execution_started_at,NOW()) ELSE execution_started_at END
       WHERE id=$1 RETURNING *`,
      [approvalId]
    );
    if (!result.rowCount) return null;
    const approval = mapApproval(result.rows[0]);
    if (approval.executionStatus === 'unknown') await markNeedsReview(client, approval);
    return approval;
  });
}

export async function markAutomationApprovalExecutionFinished(
  approvalId: string,
  resultPayload: unknown,
  isError: boolean
): Promise<AutomationRunApproval | null> {
  const result = await db.query<QueryResultRow>(
    `UPDATE automation_run_approvals SET
       execution_status=CASE WHEN $3::boolean THEN 'failed' ELSE 'succeeded' END,
       execution_finished_at=NOW(),tool_result=$2::jsonb,tool_result_is_error=$3
     WHERE id=$1 AND execution_status='executing' RETURNING *`,
    [approvalId, JSON.stringify(resultPayload ?? null), isError]
  );
  if (result.rowCount) return mapApproval(result.rows[0]);
  return getAutomationRunApproval(approvalId);
}
