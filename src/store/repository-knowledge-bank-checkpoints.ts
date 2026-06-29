import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { normalizeKnowledgeBankConfig } from '../services/knowledge-bank/config.js';
import { TargetType } from '../types/domain.js';

type Queryable = Pick<typeof db, 'query'> | PoolClient;

export interface KnowledgeBankCheckpointJob {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  sessionId: string;
  lastActivityAt: string;
  leaseOwner: string;
  config: Record<string, unknown>;
  toolEnabled: boolean;
  sessionActive: boolean;
  sessionLastMessageAt: string;
  hasActiveRun: boolean;
  hasPendingApproval: boolean;
}

interface KnowledgeBankCheckpointJobRow {
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  session_id: string;
  last_activity_at: Date;
  lease_owner: string;
  config_json: Record<string, unknown> | null;
  tool_enabled: boolean | null;
  session_active: boolean;
  session_last_message_at: Date;
  has_active_run: boolean;
  has_pending_approval: boolean;
}

function mapCheckpointJob(row: KnowledgeBankCheckpointJobRow): KnowledgeBankCheckpointJob {
  return {
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    sessionId: row.session_id,
    lastActivityAt: row.last_activity_at.toISOString(),
    leaseOwner: row.lease_owner,
    config: row.config_json || {},
    toolEnabled: row.tool_enabled ?? true,
    sessionActive: row.session_active,
    sessionLastMessageAt: row.session_last_message_at.toISOString(),
    hasActiveRun: row.has_active_run,
    hasPendingApproval: row.has_pending_approval
  };
}

export async function upsertKnowledgeBankCheckpointJobForSessionActivity(
  sessionId: string,
  activityAt: string,
  queryable: Queryable = db
): Promise<void> {
  if (!config.KNOWLEDGE_BANK_ENABLED) return;
  const sessionResult = await queryable.query<{
    workspace_id: string;
    target_id: string;
    target_type: TargetType;
    tool_enabled: boolean | null;
    config_json: Record<string, unknown> | null;
  }>(
    `SELECT s.workspace_id, s.target_id, t.target_type, setting.enabled AS tool_enabled, setting.config_json
     FROM sessions s
     JOIN targets t ON t.id = s.target_id
     LEFT JOIN target_tool_settings setting
       ON setting.target_id = s.target_id AND setting.tool_id = 'knowledge_bank'
     WHERE s.id = $1`,
    [sessionId]
  );
  if (!sessionResult.rowCount) return;
  const row = sessionResult.rows[0];
  const toolEnabled = row.tool_enabled ?? true;
  const toolConfig = normalizeKnowledgeBankConfig(row.config_json);
  const dueAt = new Date(new Date(activityAt).getTime() + toolConfig.learning.idleCheckpointDelayMinutes * 60_000).toISOString();
  await queryable.query(
    `INSERT INTO target_knowledge_checkpoint_jobs (
       workspace_id, target_id, session_id, target_type, last_activity_at, due_at,
       status, lease_owner, lease_expires_at, last_error, retry_after, updated_at
     ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, NULL, NULL, $8, NULL, NOW())
     ON CONFLICT (workspace_id, target_id, session_id) DO UPDATE
     SET target_type = EXCLUDED.target_type,
         last_activity_at = EXCLUDED.last_activity_at,
         due_at = EXCLUDED.due_at,
         status = EXCLUDED.status,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = EXCLUDED.last_error,
         retry_after = NULL,
         attempts = CASE
           WHEN target_knowledge_checkpoint_jobs.last_activity_at < EXCLUDED.last_activity_at THEN 0
           ELSE target_knowledge_checkpoint_jobs.attempts
         END,
         updated_at = NOW()
     WHERE target_knowledge_checkpoint_jobs.last_activity_at < EXCLUDED.last_activity_at`,
    [
      row.workspace_id,
      row.target_id,
      sessionId,
      row.target_type,
      activityAt,
      toolEnabled ? dueAt : null,
      toolEnabled ? 'queued' : 'skipped',
      toolEnabled ? null : 'tool_disabled'
    ]
  );
}

export async function scheduleKnowledgeBankCheckpointJobForSessionActivity(
  sessionId: string,
  activityAt: string,
  client?: PoolClient
): Promise<void> {
  if (!config.KNOWLEDGE_BANK_ENABLED) return;
  if (client) {
    await client.query('SAVEPOINT knowledge_bank_checkpoint_enqueue');
    try {
      await upsertKnowledgeBankCheckpointJobForSessionActivity(sessionId, activityAt, client);
      await client.query('RELEASE SAVEPOINT knowledge_bank_checkpoint_enqueue');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT knowledge_bank_checkpoint_enqueue');
      await client.query('RELEASE SAVEPOINT knowledge_bank_checkpoint_enqueue');
      logger.warn({ err, sessionId }, 'Failed scheduling Knowledge Bank checkpoint job for session activity');
    }
    return;
  }
  try {
    await upsertKnowledgeBankCheckpointJobForSessionActivity(sessionId, activityAt);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed scheduling Knowledge Bank checkpoint job for session activity');
  }
}

export async function claimDueKnowledgeBankCheckpointJobs(
  limit = 50,
  leaseOwner: string,
  leaseSeconds = 300
): Promise<KnowledgeBankCheckpointJob[]> {
  const result = await db.query<KnowledgeBankCheckpointJobRow>(
    `WITH due AS (
       SELECT
         job.workspace_id,
         job.target_id,
         job.target_type,
         job.session_id,
         job.last_activity_at,
         setting.config_json,
         setting.enabled AS tool_enabled,
         (s.deleted_at IS NULL AND s.expires_at > NOW()) AS session_active,
         s.last_message_at AS session_last_message_at,
         EXISTS (
           SELECT 1
           FROM runs r
           WHERE r.session_id = job.session_id
             AND r.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
         ) AS has_active_run,
         EXISTS (
           SELECT 1
           FROM run_tool_approvals a
           JOIN runs r ON r.id = a.run_id
           WHERE r.session_id = job.session_id
             AND a.status = 'pending'
         ) AS has_pending_approval
       FROM target_knowledge_checkpoint_jobs job
       JOIN sessions s ON s.id = job.session_id
       LEFT JOIN target_tool_settings setting
         ON setting.target_id = job.target_id AND setting.tool_id = 'knowledge_bank'
       WHERE job.due_at IS NOT NULL
         AND job.due_at <= NOW()
         AND job.status IN ('queued', 'failed', 'processing')
         AND (job.retry_after IS NULL OR job.retry_after <= NOW())
         AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW())
       ORDER BY job.due_at ASC, job.updated_at ASC
       LIMIT $1
       FOR UPDATE OF job SKIP LOCKED
     )
     UPDATE target_knowledge_checkpoint_jobs job
     SET status = 'processing',
         lease_owner = $2,
         lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
         attempts = job.attempts + 1,
         updated_at = NOW()
     FROM due
     WHERE job.workspace_id = due.workspace_id
       AND job.target_id = due.target_id
       AND job.session_id = due.session_id
     RETURNING
       job.workspace_id,
       job.target_id,
       job.target_type,
       job.session_id,
       job.last_activity_at,
       job.lease_owner,
       due.config_json,
       due.tool_enabled,
       due.session_active,
       due.session_last_message_at,
       due.has_active_run,
       due.has_pending_approval`,
    [Math.max(1, Math.min(200, limit)), leaseOwner, leaseSeconds]
  );
  return result.rows.map(mapCheckpointJob);
}

export async function rescheduleKnowledgeBankCheckpointJob(params: {
  workspaceId: string;
  targetId: string;
  sessionId: string;
  lastActivityAt: string;
  leaseOwner: string;
  dueAt: string;
  error?: string | null;
  retryAfter?: string | null;
}, queryable: Queryable = db): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE target_knowledge_checkpoint_jobs
     SET status = 'queued',
         due_at = $6::timestamptz,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = $7,
         retry_after = $8::timestamptz,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND target_id = $2
       AND session_id = $3
       AND last_activity_at = $4::timestamptz
       AND lease_owner = $5
       AND lease_expires_at > NOW()`,
    [
      params.workspaceId,
      params.targetId,
      params.sessionId,
      params.lastActivityAt,
      params.leaseOwner,
      params.dueAt,
      params.error || null,
      params.retryAfter || null
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function finishKnowledgeBankCheckpointJob(params: {
  workspaceId: string;
  targetId: string;
  sessionId: string;
  lastActivityAt: string;
  leaseOwner: string;
  status: string;
  error?: string | null;
  retryAfter?: string | null;
}, queryable: Queryable = db): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE target_knowledge_checkpoint_jobs
     SET status = $6,
         due_at = CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE $8::timestamptz END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = $7,
         retry_after = $8::timestamptz,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND target_id = $2
       AND session_id = $3
       AND last_activity_at = $4::timestamptz
       AND lease_owner = $5
       AND lease_expires_at > NOW()`,
    [
      params.workspaceId,
      params.targetId,
      params.sessionId,
      params.lastActivityAt,
      params.leaseOwner,
      params.status,
      params.error || null,
      params.retryAfter || null
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function renewKnowledgeBankCheckpointJobLeaseIfCurrent(params: {
  workspaceId: string;
  targetId: string;
  sessionId: string;
  lastActivityAt: string;
  leaseOwner: string;
  leaseSeconds?: number;
}, queryable: Queryable = db): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE target_knowledge_checkpoint_jobs job
     SET lease_expires_at = NOW() + ($6::int * INTERVAL '1 second'),
         updated_at = NOW()
     FROM sessions s
     WHERE job.workspace_id = $1
       AND job.target_id = $2
       AND job.session_id = $3
       AND job.status = 'processing'
       AND job.last_activity_at = $4::timestamptz
       AND job.lease_owner = $5
       AND job.lease_expires_at > NOW()
       AND s.id = job.session_id
       AND s.last_message_at = $4::timestamptz
       AND s.deleted_at IS NULL
       AND s.expires_at > NOW()
       AND NOT EXISTS (
         SELECT 1
         FROM runs r
         WHERE r.session_id = job.session_id
           AND r.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM run_tool_approvals a
         JOIN runs r ON r.id = a.run_id
         WHERE r.session_id = job.session_id
           AND a.status = 'pending'
       )`,
    [
      params.workspaceId,
      params.targetId,
      params.sessionId,
      params.lastActivityAt,
      params.leaseOwner,
      Math.max(30, Math.min(1800, params.leaseSeconds || 300))
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function requeueKnowledgeBankPausedCheckpoints(workspaceId: string, targetId?: string): Promise<number> {
  const result = await db.query(
    `UPDATE target_knowledge_checkpoint_jobs job
     SET status = 'queued',
         due_at = NOW(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = NULL,
         retry_after = NULL,
         updated_at = NOW()
     WHERE job.workspace_id = $1
       AND ($2::text IS NULL OR job.target_id = $2)
       AND job.status = 'skipped'
       AND job.last_error = ANY($3::text[])`,
    [workspaceId, targetId || null, ['ai_settings_missing', 'provider_not_allowed', 'model_not_allowed', 'tool_disabled']]
  );
  return result.rowCount ?? 0;
}
