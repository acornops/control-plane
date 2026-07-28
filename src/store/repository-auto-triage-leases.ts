import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import type { AutoTriageJobStatus } from '../types/auto-triage.js';

type Queryable = Pick<typeof db, 'query'> | PoolClient;

export async function updateClaimedTargetAutoTriageJob(input: {
  jobId: string;
  leaseOwner: string;
  status: AutoTriageJobStatus;
  sessionId?: string | null;
  runId?: string | null;
  errorCode?: string | null;
  internalErrorMessage?: string | null;
  nextAttemptAt?: string;
  resetAttemptCount?: boolean;
}, queryable: Queryable = db): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE target_auto_triage_jobs
        SET status = $3,
            session_id = COALESCE($4, session_id),
            run_id = COALESCE($5, run_id),
            error_code = $6,
            internal_error_message = $7,
            next_attempt_at = COALESCE($8::timestamptz, next_attempt_at),
            attempt_count = CASE WHEN $9::boolean THEN 0 ELSE attempt_count END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND lease_owner = $2
        AND lease_expires_at > NOW()`,
    [
      input.jobId,
      input.leaseOwner,
      input.status,
      input.sessionId ?? null,
      input.runId ?? null,
      input.errorCode?.slice(0, 64) ?? null,
      input.internalErrorMessage?.slice(0, 1000) ?? null,
      input.nextAttemptAt ?? null,
      input.resetAttemptCount === true
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function lockClaimedTargetAutoTriageJob(
  jobId: string,
  leaseOwner: string,
  client: PoolClient
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM target_auto_triage_jobs
      WHERE id = $1
        AND lease_owner = $2
        AND lease_expires_at > NOW()
      FOR UPDATE`,
    [jobId, leaseOwner]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function lockEnabledTargetAutoTriageSettingsRevision(
  workspaceId: string,
  targetId: string,
  expectedRevision: number,
  client: PoolClient
): Promise<boolean> {
  const result = await client.query(
    `SELECT target_id
       FROM target_auto_triage_settings
      WHERE workspace_id = $1
        AND target_id = $2
        AND enabled = TRUE
        AND revision = $3
      FOR SHARE`,
    [workspaceId, targetId, expectedRevision]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function resetClaimedTargetAutoTriageAttemptCount(
  jobId: string,
  leaseOwner: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE target_auto_triage_jobs
        SET attempt_count = 1,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'processing'
        AND lease_owner = $2
        AND lease_expires_at > NOW()`,
    [jobId, leaseOwner]
  );
  return (result.rowCount ?? 0) > 0;
}
