import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { canonicalJsonSha256 } from '../services/canonical-json.js';
import type { ApprovalReceiptClaims } from '../services/token-service.js';
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
  toolRef: { serverId: string; toolName: string };
  summary?: string;
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
           server_id, server_tool_name, requested_tool_alias, arguments_digest,
           summary, arguments, status, execution_status, requested_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11::jsonb,'pending','not_started',$12,$13)
         ON CONFLICT (run_id, tool_call_id) DO UPDATE
           SET tool_name = EXCLUDED.tool_name,
               server_id = EXCLUDED.server_id,
               server_tool_name = EXCLUDED.server_tool_name,
               requested_tool_alias = EXCLUDED.requested_tool_alias,
               arguments_digest = EXCLUDED.arguments_digest,
               summary = COALESCE(EXCLUDED.summary, run_tool_approvals.summary),
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
        params.toolRef.serverId,
        params.toolRef.toolName,
        canonicalJsonSha256(params.arguments || {}),
        params.summary || null,
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
          ...(params.summary ? { summary: params.summary } : {}),
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

export async function listWorkspaceRunToolApprovals(params: {
  workspaceId: string;
  status?: 'pending' | 'decided' | 'all';
  limit?: number;
  cursor?: string;
}): Promise<RunToolApproval[]> {
  const status = params.status || 'pending';
  const limit = Math.max(1, Math.min(100, params.limit || 50));
  const values: unknown[] = [params.workspaceId];
  const where = ['a.workspace_id = $1'];
  if (status === 'pending') {
    where.push("a.status = 'pending'");
  } else if (status === 'decided') {
    where.push("a.status <> 'pending'");
  }
  if (params.cursor) {
    values.push(params.cursor);
    where.push(`a.created_at < $${values.length}::timestamptz`);
  }
  values.push(limit);
  const result = await db.query<RunToolApprovalRow>(
    `${RUN_TOOL_APPROVAL_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapRunToolApproval);
}

export async function countPendingWorkspaceRunToolApprovals(workspaceId: string): Promise<number> {
  const result = await db.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count
     FROM run_tool_approvals
     WHERE workspace_id = $1
       AND status = 'pending'`,
    [workspaceId]
  );
  return Number(result.rows[0]?.count || 0);
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

export class ApprovalExecutionStartError extends Error {
  constructor(readonly code: 'APPROVAL_NOT_GRANTED' | 'APPROVAL_EXECUTION_ALREADY_STARTED', readonly approval: RunToolApproval) {
    super(code);
  }
}

export async function startRunToolApprovalExecution(
  approvalId: string,
  issueReceipt: (claims: ApprovalReceiptClaims) => Promise<string>
): Promise<{ approval: RunToolApproval; approvalReceipt: string } | null> {
  return withTransaction(async (client) => {
    const locked = await client.query<RunToolApprovalRow>(
      `${RUN_TOOL_APPROVAL_SELECT} WHERE a.id = $1 FOR UPDATE OF a`, [approvalId]
    );
    if (!locked.rowCount) return null;
    const approval = mapRunToolApproval(locked.rows[0]);
    if (approval.status !== 'approved') throw new ApprovalExecutionStartError('APPROVAL_NOT_GRANTED', approval);
    if (approval.executionStatus !== 'not_started') {
      throw new ApprovalExecutionStartError('APPROVAL_EXECUTION_ALREADY_STARTED', approval);
    }
    const approvalReceipt = await issueReceipt({
      approvalId: approval.id,
      runId: approval.runId,
      workspaceId: approval.workspaceId,
      toolCallId: approval.toolCallId,
      toolAlias: approval.requestedToolAlias,
      serverId: approval.toolRef.serverId,
      serverToolName: approval.toolRef.toolName,
      argumentsDigest: approval.argumentsDigest
    });
    const updated = await client.query<RunToolApprovalRow>(
      `WITH changed AS (
         UPDATE run_tool_approvals SET execution_status='executing',execution_started_at=NOW()
         WHERE id=$1 AND status='approved' AND execution_status='not_started' RETURNING *
       ) SELECT a.*,t.target_type FROM changed a JOIN targets t ON t.id=a.target_id`, [approvalId]
    );
    if (!updated.rowCount) throw new ApprovalExecutionStartError('APPROVAL_EXECUTION_ALREADY_STARTED', approval);
    return { approval: mapRunToolApproval(updated.rows[0]), approvalReceipt };
  });
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
