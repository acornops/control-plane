import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { RunContinuation, RunToolApproval } from '../types/domain.js';
import {
  mapRunContinuation,
  mapRunToolApproval,
  RunContinuationRow,
  RunToolApprovalRow
} from './repository-mappers.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { withTransaction } from './repository-transaction.js';

const RUN_TOOL_APPROVAL_SELECT = `
  SELECT a.*, t.target_type
  FROM run_tool_approvals a
  JOIN targets t ON t.id = a.target_id`;

export async function createRunToolApproval(params: {
  runId: string;
  workspaceId: string;
  targetId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestedBy?: string;
  sessionId?: string;
  expiresAt: string;
  continuationState?: Record<string, unknown>;
}): Promise<RunToolApproval> {
  return withTransaction(async (client) => {
    const id = randomUUID();
    const result = await client.query<RunToolApprovalRow>(
      `WITH upserted AS (
         INSERT INTO run_tool_approvals (
           id, run_id, workspace_id, target_id, tool_call_id, tool_name,
           arguments, status, execution_status, requested_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending','not_started',$8,$9)
         ON CONFLICT (run_id, tool_call_id) DO UPDATE
           SET tool_name = EXCLUDED.tool_name,
               arguments = EXCLUDED.arguments
         RETURNING *
       )
       SELECT a.*, t.target_type
       FROM upserted a
       JOIN targets t ON t.id = a.target_id`,
      [
        id,
        params.runId,
        params.workspaceId,
        params.targetId,
        params.toolCallId,
        params.toolName,
        JSON.stringify(params.arguments || {}),
        params.requestedBy || null,
        params.expiresAt
      ]
    );
    const approval = mapRunToolApproval(result.rows[0]);
    if (params.continuationState) {
      await client.query(
        `INSERT INTO run_continuations (run_id, approval_id, schema_version, state)
         VALUES ($1, $2, 1, $3::jsonb)
         ON CONFLICT (run_id) DO UPDATE
           SET approval_id = EXCLUDED.approval_id,
               schema_version = EXCLUDED.schema_version,
               state = EXCLUDED.state,
               updated_at = NOW()`,
        [params.runId, approval.id, JSON.stringify(params.continuationState)]
      );
      await client.query(
        `UPDATE runs
         SET status = 'waiting_for_approval'
         WHERE id = $1
           AND status NOT IN ('completed', 'failed', 'cancelled')`,
        [params.runId]
      );
    }
    await insertWorkspaceAuditEvent(
      {
        workspaceId: params.workspaceId,
        category: 'approval',
        eventType: 'run.tool_approval_requested.v1',
        operation: 'write',
        actorUserId: params.requestedBy || null,
        objectType: 'tool_approval',
        objectId: approval.id,
        objectName: approval.toolName,
        summary: 'Write-tool approval requested',
        metadata: {
          runId: params.runId,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          targetId: params.targetId,
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          expiresAt: params.expiresAt
        }
      },
      client
    );
    return approval;
  });
}

export async function getRunToolApproval(approvalId: string): Promise<RunToolApproval | null> {
  const result = await db.query<RunToolApprovalRow>(`${RUN_TOOL_APPROVAL_SELECT} WHERE a.id = $1`, [approvalId]);
  if (!result.rowCount) return null;
  return mapRunToolApproval(result.rows[0]);
}

export async function listRunToolApprovals(runId: string): Promise<RunToolApproval[]> {
  const result = await db.query<RunToolApprovalRow>(
    `${RUN_TOOL_APPROVAL_SELECT} WHERE a.run_id = $1 ORDER BY a.created_at ASC`,
    [runId]
  );
  return result.rows.map(mapRunToolApproval);
}

export async function getRunContinuation(runId: string): Promise<RunContinuation | null> {
  const result = await db.query<RunContinuationRow>('SELECT * FROM run_continuations WHERE run_id = $1', [runId]);
  if (!result.rowCount) return null;
  return mapRunContinuation(result.rows[0]);
}

export async function deleteRunContinuation(runId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM run_continuations WHERE run_id = $1', [runId]);
  return (result.rowCount ?? 0) > 0;
}

export async function decideRunToolApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string
): Promise<RunToolApproval | null> {
  const status = decision === 'approved' ? 'approved' : 'rejected';
  const result = await db.query<RunToolApprovalRow>(
    `WITH updated AS (
       UPDATE run_tool_approvals
       SET status = CASE
             WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired'
             WHEN status = 'pending' THEN $2
             ELSE status
           END,
           decision = CASE
             WHEN status = 'pending' AND expires_at > NOW() THEN $3
             ELSE decision
           END,
           decided_by = CASE
             WHEN status = 'pending' AND expires_at > NOW() THEN $4
             ELSE decided_by
           END,
           decided_at = CASE
             WHEN status = 'pending' AND expires_at > NOW() THEN NOW()
             ELSE decided_at
           END
       WHERE id = $1
       RETURNING *
     )
     SELECT a.*, t.target_type
     FROM updated a
     JOIN targets t ON t.id = a.target_id`,
    [approvalId, status, decision, decidedBy]
  );
  if (!result.rowCount) return null;
  return mapRunToolApproval(result.rows[0]);
}

export async function expireRunToolApproval(approvalId: string): Promise<RunToolApproval | null> {
  const result = await db.query<RunToolApprovalRow>(
    `WITH updated AS (
       UPDATE run_tool_approvals
       SET status = 'expired'
       WHERE id = $1
         AND status = 'pending'
       RETURNING *
     )
     SELECT a.*, t.target_type
     FROM updated a
     JOIN targets t ON t.id = a.target_id`,
    [approvalId]
  );
  if (!result.rowCount) return getRunToolApproval(approvalId);
  return mapRunToolApproval(result.rows[0]);
}

export async function expirePendingRunToolApprovals(limit = 100): Promise<RunToolApproval[]> {
  const result = await db.query<RunToolApprovalRow>(
    `WITH updated AS (
       UPDATE run_tool_approvals
       SET status = 'expired'
       WHERE id IN (
         SELECT id
         FROM run_tool_approvals
         WHERE status = 'pending'
           AND expires_at <= NOW()
         ORDER BY expires_at ASC
         LIMIT $1
       )
       RETURNING *
     )
     SELECT a.*, t.target_type
     FROM updated a
     JOIN targets t ON t.id = a.target_id`,
    [Math.max(1, Math.min(1000, limit))]
  );
  return result.rows.map(mapRunToolApproval);
}

export async function markRunToolApprovalExecutionStarted(approvalId: string): Promise<RunToolApproval | null> {
  const result = await db.query<RunToolApprovalRow>(
    `WITH updated AS (
       UPDATE run_tool_approvals
       SET execution_status = CASE
             WHEN execution_status = 'not_started' THEN 'executing'
             WHEN execution_status = 'executing' THEN 'unknown'
             ELSE execution_status
           END,
           execution_started_at = COALESCE(execution_started_at, NOW())
       WHERE id = $1
       RETURNING *
     )
     SELECT a.*, t.target_type
     FROM updated a
     JOIN targets t ON t.id = a.target_id`,
    [approvalId]
  );
  if (!result.rowCount) return null;
  return mapRunToolApproval(result.rows[0]);
}

export async function markRunToolApprovalExecutionFinished(
  approvalId: string,
  resultPayload: unknown,
  isError: boolean
): Promise<RunToolApproval | null> {
  const result = await db.query<RunToolApprovalRow>(
    `WITH updated AS (
       UPDATE run_tool_approvals
       SET execution_status = CASE WHEN $3::boolean THEN 'failed' ELSE 'succeeded' END,
           execution_finished_at = NOW(),
           tool_result = $2::jsonb,
           tool_result_is_error = $3
       WHERE id = $1
         AND execution_status = 'executing'
       RETURNING *
     )
     SELECT a.*, t.target_type
     FROM updated a
     JOIN targets t ON t.id = a.target_id`,
    [approvalId, JSON.stringify(resultPayload ?? null), isError]
  );
  if (!result.rowCount) return getRunToolApproval(approvalId);
  return mapRunToolApproval(result.rows[0]);
}
