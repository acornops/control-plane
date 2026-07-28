import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import type {
  AutoTriageJobTriggerReason,
  TargetAutoTriageJob,
  TargetAutoTriageSettings
} from '../types/auto-triage.js';
import type { TargetIssue, TargetIssueSeverity, TargetType } from '../types/domain.js';
import { incrementAutoTriageQueued } from '../metrics-auto-triage.js';
import { toIso } from './repository-mappers.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import {
  type AutoTriageJobRow,
  mapAutoTriageJob
} from './repository-auto-triage-job-mappers.js';
import { requeueDisabledTargetAutoTriageJob } from './repository-auto-triage-requeue.js';
import { withTransaction } from './repository-transaction.js';

type Queryable = Pick<typeof db, 'query'> | PoolClient;

const DEFAULT_SETTINGS = {
  enabled: false,
  minimumSeverity: 'warning' as const,
  writeMode: 'follow_target' as const,
  additionalInstructions: '',
  revision: 0
};

interface AutoTriageSettingsRow {
  workspace_id: string;
  target_id: string;
  enabled: boolean;
  minimum_severity: TargetAutoTriageSettings['minimumSeverity'];
  write_mode: TargetAutoTriageSettings['writeMode'];
  additional_instructions: string;
  revision: number | string;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapSettings(row: AutoTriageSettingsRow): TargetAutoTriageSettings {
  return {
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    enabled: row.enabled,
    minimumSeverity: row.minimum_severity,
    writeMode: row.write_mode,
    additionalInstructions: row.additional_instructions,
    revision: Number(row.revision),
    updatedBy: row.updated_by || undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function severityRank(severity: TargetIssueSeverity): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

export function issueMeetsAutoTriageThreshold(
  issueSeverity: TargetIssueSeverity,
  minimumSeverity: TargetIssueSeverity
): boolean {
  return severityRank(issueSeverity) <= severityRank(minimumSeverity);
}

export async function getTargetAutoTriageSettings(
  workspaceId: string,
  targetId: string,
  queryable: Queryable = db
): Promise<TargetAutoTriageSettings> {
  const result = await queryable.query<AutoTriageSettingsRow>(
    `SELECT *
       FROM target_auto_triage_settings
      WHERE workspace_id = $1 AND target_id = $2`,
    [workspaceId, targetId]
  );
  return result.rows[0]
    ? mapSettings(result.rows[0])
    : {
        workspaceId,
        targetId,
        ...DEFAULT_SETTINGS
      };
}

export async function saveTargetAutoTriageSettings(input: {
  workspaceId: string;
  targetId: string;
  expectedRevision: number;
  enabled: boolean;
  minimumSeverity: TargetAutoTriageSettings['minimumSeverity'];
  writeMode: TargetAutoTriageSettings['writeMode'];
  additionalInstructions: string;
  updatedBy: string;
}): Promise<TargetAutoTriageSettings | null> {
  if (input.expectedRevision === 0) {
    const inserted = await db.query<AutoTriageSettingsRow>(
      `INSERT INTO target_auto_triage_settings (
         workspace_id, target_id, enabled, minimum_severity, write_mode,
         additional_instructions, revision, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7)
       ON CONFLICT (target_id) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId,
        input.targetId,
        input.enabled,
        input.minimumSeverity,
        input.writeMode,
        input.additionalInstructions,
        input.updatedBy
      ]
    );
    return inserted.rowCount ? mapSettings(inserted.rows[0]) : null;
  }

  const updated = await db.query<AutoTriageSettingsRow>(
    `UPDATE target_auto_triage_settings
        SET enabled = $4,
            minimum_severity = $5,
            write_mode = $6,
            additional_instructions = $7,
            revision = revision + 1,
            updated_by = $8,
            updated_at = NOW()
      WHERE workspace_id = $1
        AND target_id = $2
        AND revision = $3
      RETURNING *`,
    [
      input.workspaceId,
      input.targetId,
      input.expectedRevision,
      input.enabled,
      input.minimumSeverity,
      input.writeMode,
      input.additionalInstructions,
      input.updatedBy
    ]
  );
  return updated.rowCount ? mapSettings(updated.rows[0]) : null;
}

export async function enqueueTargetAutoTriageJob(
  client: Queryable,
  issue: Pick<TargetIssue, 'id' | 'workspaceId' | 'targetId' | 'targetType' | 'lifecycleVersion'>,
  triggerReason: AutoTriageJobTriggerReason,
  settingsRevision: number
): Promise<boolean> {
  if (
    triggerReason === 'existing_issue_start'
    && await requeueDisabledTargetAutoTriageJob(client, issue, settingsRevision)
  ) {
    return true;
  }

  const jobId = randomUUID();
  const result = await client.query(
    `INSERT INTO target_auto_triage_jobs (
       id, workspace_id, target_id, target_type, issue_id, issue_lifecycle_version,
       trigger_reason, status, settings_revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)
     ON CONFLICT (issue_id, issue_lifecycle_version) DO NOTHING`,
    [
      jobId,
      issue.workspaceId,
      issue.targetId,
      issue.targetType,
      issue.id,
      issue.lifecycleVersion,
      triggerReason,
      settingsRevision
    ]
  );
  const inserted = (result.rowCount ?? 0) > 0;
  if (inserted) {
    incrementAutoTriageQueued(triggerReason);
    await insertWorkspaceAuditEvent({
      workspaceId: issue.workspaceId,
      category: 'run',
      eventType: 'target.auto_triage_job_queued.v1',
      operation: 'write',
      actorType: 'system',
      objectType: 'target_auto_triage_job',
      objectId: jobId,
      summary: 'Automatic investigation job queued',
      metadata: {
        targetId: issue.targetId,
        targetType: issue.targetType,
        issueId: issue.id,
        issueLifecycleVersion: issue.lifecycleVersion,
        triggerReason
      }
    }, client);
  }
  return inserted;
}

export async function enqueueCurrentTargetAutoTriageIssues(input: {
  workspaceId: string;
  targetId: string;
  expectedSettingsRevision: number;
}): Promise<{ queuedCount: number; alreadyExistsCount: number; skippedCount: number } | null> {
  return withTransaction(async (client) => {
    const settingsResult = await client.query<AutoTriageSettingsRow>(
      `SELECT *
         FROM target_auto_triage_settings
        WHERE workspace_id = $1
          AND target_id = $2
        FOR UPDATE`,
      [input.workspaceId, input.targetId]
    );
    if (!settingsResult.rowCount) return null;
    const settings = mapSettings(settingsResult.rows[0]);
    if (!settings.enabled || settings.revision !== input.expectedSettingsRevision) return null;

    const issues = await client.query<{
      id: string;
      workspace_id: string;
      target_id: string;
      target_type: TargetType;
      lifecycle_version: number | string;
    }>(
      `SELECT id, workspace_id, target_id, target_type, lifecycle_version
         FROM target_issues
        WHERE workspace_id = $1
          AND target_id = $2
          AND status IN ('active', 'recovering')
          AND severity_rank <= $3
        ORDER BY severity_rank ASC, first_seen_at ASC, id ASC
        FOR UPDATE`,
      [input.workspaceId, input.targetId, severityRank(settings.minimumSeverity)]
    );
    let queuedCount = 0;
    let alreadyExistsCount = 0;
    for (const issue of issues.rows) {
      const queued = await enqueueTargetAutoTriageJob(
        client,
        {
          id: issue.id,
          workspaceId: issue.workspace_id,
          targetId: issue.target_id,
          targetType: issue.target_type,
          lifecycleVersion: Number(issue.lifecycle_version)
        },
        'existing_issue_start',
        settings.revision
      );
      if (queued) queuedCount += 1;
      else alreadyExistsCount += 1;
    }
    return { queuedCount, alreadyExistsCount, skippedCount: 0 };
  });
}

export async function retryTargetAutoTriageIssue(
  workspaceId: string,
  issueId: string
): Promise<TargetAutoTriageJob | null> {
  const result = await db.query<AutoTriageJobRow>(
    `UPDATE target_auto_triage_jobs job
        SET status = 'queued',
            trigger_reason = 'retry',
            run_id = NULL,
            retry_generation = retry_generation + 1,
            attempt_count = 0,
            next_attempt_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            internal_error_message = NULL,
            updated_at = NOW()
       FROM target_issues issue,
            target_auto_triage_settings settings
      WHERE job.workspace_id = $1
        AND job.issue_id = $2
        AND issue.id = job.issue_id
        AND issue.lifecycle_version = job.issue_lifecycle_version
        AND issue.status IN ('active', 'recovering')
        AND settings.workspace_id = job.workspace_id
        AND settings.target_id = job.target_id
        AND settings.enabled = TRUE
        AND issue.severity_rank <= CASE settings.minimum_severity
              WHEN 'critical' THEN 0
              WHEN 'warning' THEN 1
              ELSE 2
            END
        AND job.status = 'failed'
        AND (
          job.session_created_at IS NULL
          OR EXISTS (
            SELECT 1
              FROM sessions session
             WHERE session.id = job.session_id
               AND session.deleted_at IS NULL
               AND session.expires_at > NOW()
          )
        )
      RETURNING job.*`,
    [workspaceId, issueId]
  );
  if (!result.rowCount) return null;
  incrementAutoTriageQueued('retry');
  return mapAutoTriageJob(result.rows[0]);
}

export async function getTargetAutoTriageJobForIssueLifecycle(
  workspaceId: string,
  issueId: string,
  lifecycleVersion: number,
  queryable: Queryable = db
): Promise<TargetAutoTriageJob | null> {
  const result = await queryable.query<AutoTriageJobRow>(
    `SELECT *
       FROM target_auto_triage_jobs
      WHERE workspace_id = $1
        AND issue_id = $2
        AND issue_lifecycle_version = $3`,
    [workspaceId, issueId, lifecycleVersion]
  );
  return result.rowCount ? mapAutoTriageJob(result.rows[0]) : null;
}

export async function claimDueTargetAutoTriageJobs(
  leaseOwner: string,
  limit = 25,
  leaseSeconds = 120
): Promise<TargetAutoTriageJob[]> {
  const result = await db.query<AutoTriageJobRow>(
     `WITH candidates AS (
       SELECT job.id
         FROM target_auto_triage_jobs job
         JOIN targets target_record ON target_record.id = job.target_id
         JOIN (
           SELECT eligible.id,
                  ROW_NUMBER() OVER (
                    PARTITION BY eligible.target_id
                    ORDER BY eligible.next_attempt_at ASC, eligible.created_at ASC, eligible.id ASC
                  ) AS target_queue_position,
                  (
                    SELECT COUNT(*)
                      FROM target_auto_triage_jobs active_job
                      LEFT JOIN runs active_run ON active_run.id = active_job.run_id
                     WHERE active_job.target_id = eligible.target_id
                       AND (
                         (
                           active_job.status = 'processing'
                           AND active_job.lease_expires_at > NOW()
                         )
                         OR (
                           active_job.status IN ('started', 'stopping')
                           AND active_run.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
                         )
                       )
                  ) AS active_count
             FROM target_auto_triage_jobs eligible
            WHERE eligible.status IN ('queued', 'blocked', 'processing')
              AND eligible.next_attempt_at <= NOW()
              AND (eligible.lease_expires_at IS NULL OR eligible.lease_expires_at <= NOW())
         ) ranked ON ranked.id = job.id
        WHERE ranked.target_queue_position <= GREATEST(0, 2 - ranked.active_count)
        ORDER BY job.next_attempt_at ASC, job.created_at ASC, job.id ASC
        LIMIT $1
        FOR UPDATE OF job, target_record SKIP LOCKED
     )
     UPDATE target_auto_triage_jobs job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            lease_owner = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            updated_at = NOW()
       FROM candidates
      WHERE job.id = candidates.id
      RETURNING job.*`,
    [Math.max(1, Math.min(100, limit)), leaseOwner, leaseSeconds]
  );
  return result.rows.map(mapAutoTriageJob);
}

export async function claimStoppingTargetAutoTriageJobs(
  leaseOwner: string,
  limit = 25,
  leaseSeconds = 120
): Promise<TargetAutoTriageJob[]> {
  const result = await db.query<AutoTriageJobRow>(
    `WITH candidates AS (
       SELECT id
        FROM target_auto_triage_jobs
        WHERE status = 'stopping'
          AND next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY updated_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE target_auto_triage_jobs job
        SET lease_owner = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            attempt_count = attempt_count + 1,
            updated_at = NOW()
       FROM candidates
      WHERE job.id = candidates.id
      RETURNING job.*`,
    [Math.max(1, Math.min(100, limit)), leaseOwner, leaseSeconds]
  );
  return result.rows.map(mapAutoTriageJob);
}

export async function countActiveTargetAutoTriageRuns(): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM target_auto_triage_jobs job
       JOIN runs run ON run.id = job.run_id
      WHERE job.status IN ('started', 'stopping')
        AND run.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')`
  );
  return Number(result.rows[0]?.count || 0);
}

export async function synchronizeTargetAutoTriageTerminalRuns(): Promise<TargetAutoTriageJob[]> {
  const result = await db.query<AutoTriageJobRow>(
    `UPDATE target_auto_triage_jobs job
        SET status = CASE
              WHEN run.status = 'completed' THEN 'completed'
              WHEN run.status = 'cancelled' THEN 'skipped'
              ELSE 'failed'
            END,
            error_code = CASE
              WHEN run.status = 'failed' THEN LEFT(COALESCE(run.error_code, 'RUN_FAILED'), 64)
              WHEN run.status = 'cancelled' THEN LEFT(COALESCE(job.error_code, 'RUN_CANCELLED'), 64)
              ELSE NULL
            END,
            internal_error_message = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
       FROM runs run
      WHERE job.run_id = run.id
        AND job.status IN ('processing', 'started', 'stopping')
        AND run.status IN ('completed', 'failed', 'cancelled')
      RETURNING job.*`
  );
  return result.rows.map(mapAutoTriageJob);
}

export async function linkClaimedTargetAutoTriageJob(input: {
  jobId: string;
  leaseOwner: string;
  sessionId: string;
  runId: string;
}, queryable: Queryable = db): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE target_auto_triage_jobs
        SET session_id = $3,
            session_created_at = COALESCE(session_created_at, NOW()),
            run_id = $4,
            updated_at = NOW()
      WHERE id = $1
        AND lease_owner = $2
        AND lease_expires_at > NOW()`,
    [input.jobId, input.leaseOwner, input.sessionId, input.runId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function stopTargetAutoTriageJobsForResolvedIssue(
  client: Queryable,
  issueId: string
): Promise<Array<{ jobId: string; runId?: string }>> {
  const result = await client.query<{ id: string; run_id: string | null }>(
    `UPDATE target_auto_triage_jobs
        SET status = CASE
              WHEN run_id IS NULL THEN 'skipped'
              ELSE 'stopping'
            END,
            error_code = CASE
              WHEN run_id IS NULL THEN 'ISSUE_RESOLVED_BEFORE_START'
              ELSE 'ISSUE_RESOLVED'
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE issue_id = $1
        AND status IN ('queued', 'processing', 'blocked', 'started')
      RETURNING id, run_id`,
    [issueId]
  );
  return result.rows.map((row) => ({ jobId: row.id, runId: row.run_id || undefined }));
}

export {
  countEligibleCurrentAutoTriageIssues,
  getAutomaticInvestigationActivityByIssueIds
} from './repository-auto-triage-activity.js';
export {
  lockClaimedTargetAutoTriageJob,
  lockEnabledTargetAutoTriageSettingsRevision,
  resetClaimedTargetAutoTriageAttemptCount,
  updateClaimedTargetAutoTriageJob
} from './repository-auto-triage-leases.js';
