import { db } from '../infra/db.js';
import type {
  AutoTriageRuntimeMetricsSnapshot,
  AutomaticInvestigationSummary,
  AutoTriageJobStatus,
  AutoTriageWriteMode,
  TargetAutoTriageQueueSummary
} from '../types/auto-triage.js';
import type { TargetIssueSeverity } from '../types/domain.js';
import { toIso } from './repository-mappers.js';
import { AUTO_TRIAGE_SCOPE_SQL } from './repository-auto-triage-scope.js';

interface AutomaticInvestigationRow {
  issue_id: string;
  issue_lifecycle_version: number | string;
  job_status: AutoTriageJobStatus;
  session_id: string | null;
  session_created_at: Date | string | null;
  session_unavailable: boolean;
  run_id: string | null;
  run_status: string | null;
  error_code: string | null;
  write_mode: AutoTriageWriteMode | null;
  retry_eligible: boolean;
  updated_at: Date | string;
}

function severityRank(severity: TargetIssueSeverity): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

export async function countEligibleCurrentAutoTriageIssues(
  workspaceId: string,
  targetId: string,
  minimumSeverity: TargetIssueSeverity
): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM target_issues issue
       LEFT JOIN target_auto_triage_settings settings
         ON settings.workspace_id = issue.workspace_id
        AND settings.target_id = issue.target_id
      WHERE issue.workspace_id = $1
        AND issue.target_id = $2
        AND issue.status IN ('active', 'recovering')
        AND issue.severity_rank <= $3
        AND (
          settings.target_id IS NULL
          OR ${AUTO_TRIAGE_SCOPE_SQL('issue', 'settings')}
        )
        AND (
          NOT EXISTS (
            SELECT 1
              FROM target_auto_triage_jobs job
             WHERE job.issue_id = issue.id
               AND job.issue_lifecycle_version = issue.lifecycle_version
          )
          OR EXISTS (
            SELECT 1
              FROM target_auto_triage_jobs job
             WHERE job.issue_id = issue.id
               AND job.issue_lifecycle_version = issue.lifecycle_version
               AND job.status = 'skipped'
               AND job.session_created_at IS NULL
               AND job.error_code IN ('AUTO_TRIAGE_DISABLED', 'ISSUE_NOT_ELIGIBLE')
          )
        )`,
    [workspaceId, targetId, severityRank(minimumSeverity)]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function getTargetAutoTriageQueueSummary(
  workspaceId: string,
  targetId: string
): Promise<TargetAutoTriageQueueSummary> {
  const result = await db.query<{
    active_count: number | string;
    waiting_count: number | string;
    oldest_waiting_at: Date | string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE (
           job.status = 'processing'
           AND job.lease_expires_at > NOW()
         ) OR (
           job.status IN ('started', 'stopping')
           AND run.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
         )
       )::int AS active_count,
       COUNT(*) FILTER (
         WHERE job.status IN ('queued', 'blocked')
            OR (
              job.status = 'processing'
              AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW())
            )
       )::int AS waiting_count,
       MIN(job.created_at) FILTER (
         WHERE job.status IN ('queued', 'blocked')
            OR (
              job.status = 'processing'
              AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW())
            )
       ) AS oldest_waiting_at
       FROM target_auto_triage_jobs job
       LEFT JOIN runs run ON run.id = job.run_id
      WHERE job.workspace_id = $1
        AND job.target_id = $2
        AND job.status IN ('queued', 'blocked', 'processing', 'started', 'stopping')`,
    [workspaceId, targetId]
  );
  const row = result.rows[0];
  return {
    activeCount: Number(row?.active_count || 0),
    waitingCount: Number(row?.waiting_count || 0),
    oldestWaitingAt: toIso(row?.oldest_waiting_at) || undefined
  };
}

export async function getAutoTriageRuntimeMetricsSnapshot(): Promise<AutoTriageRuntimeMetricsSnapshot> {
  const result = await db.query<{
    active_runs: number | string;
    queued: number | string;
    blocked: number | string;
    processing: number | string;
    started: number | string;
    stopping: number | string;
    oldest_waiting_age_seconds: number | string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE job.status IN ('started', 'stopping')
           AND run.status IN ('queued', 'dispatching', 'running', 'waiting_for_approval', 'cancelling')
       )::int AS active_runs,
       COUNT(*) FILTER (WHERE job.status = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE job.status = 'blocked')::int AS blocked,
       COUNT(*) FILTER (WHERE job.status = 'processing')::int AS processing,
       COUNT(*) FILTER (WHERE job.status = 'started')::int AS started,
       COUNT(*) FILTER (WHERE job.status = 'stopping')::int AS stopping,
       COALESCE(
         EXTRACT(EPOCH FROM (
           NOW() - MIN(job.created_at) FILTER (
             WHERE job.status IN ('queued', 'blocked')
                OR (
                  job.status = 'processing'
                  AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW())
                )
           )
         )),
         0
       )::int AS oldest_waiting_age_seconds
       FROM target_auto_triage_jobs job
       LEFT JOIN runs run ON run.id = job.run_id
      WHERE job.status IN ('queued', 'blocked', 'processing', 'started', 'stopping')`
  );
  const row = result.rows[0];
  return {
    activeRuns: Number(row?.active_runs || 0),
    queued: Number(row?.queued || 0),
    blocked: Number(row?.blocked || 0),
    processing: Number(row?.processing || 0),
    started: Number(row?.started || 0),
    stopping: Number(row?.stopping || 0),
    oldestWaitingAgeSeconds: Math.max(0, Number(row?.oldest_waiting_age_seconds || 0))
  };
}

function mapInvestigation(
  row: AutomaticInvestigationRow,
  retryPermissions?: { readOnly: boolean; writeCapable: boolean }
): AutomaticInvestigationSummary {
  let state: AutomaticInvestigationSummary['state'];
  if (row.session_unavailable || (!row.session_id && row.session_created_at)) state = 'deleted';
  else if (row.run_status === 'waiting_for_approval') state = 'awaiting_approval';
  else if (row.run_status === 'completed' || row.job_status === 'completed') state = 'findings_ready';
  else if (row.run_status === 'cancelled' || row.job_status === 'stopping' || row.job_status === 'skipped') state = 'cancelled';
  else if (row.run_status && ['queued', 'dispatching', 'running', 'cancelling'].includes(row.run_status)) state = 'investigating';
  else if (row.job_status === 'failed') state = 'failed';
  else state = 'queued';
  return {
    issueId: row.issue_id,
    lifecycleVersion: Number(row.issue_lifecycle_version),
    state,
    sessionId: row.session_id || undefined,
    runId: row.run_id || undefined,
    updatedAt: toIso(row.updated_at)!,
    errorCode: row.error_code || undefined,
    canRetry: state === 'failed'
      && row.retry_eligible
      && (
        !retryPermissions
        || (row.write_mode === 'read_only' ? retryPermissions.readOnly : retryPermissions.writeCapable)
      )
  };
}

export async function getAutomaticInvestigationActivityByIssueIds(
  workspaceId: string,
  issueIds: string[],
  retryPermissions?: { readOnly: boolean; writeCapable: boolean }
): Promise<Map<string, AutomaticInvestigationSummary>> {
  if (!issueIds.length) return new Map();
  const result = await db.query<AutomaticInvestigationRow>(
    `SELECT job.issue_id,
            job.issue_lifecycle_version,
            job.status AS job_status,
            job.session_id,
            job.session_created_at,
            (
              session.deleted_at IS NOT NULL
              OR (session.id IS NOT NULL AND session.expires_at <= NOW())
            ) AS session_unavailable,
            job.run_id,
            run.status AS run_status,
            job.error_code,
            settings.write_mode,
            (
              settings.enabled IS TRUE
              AND issue.status IN ('active', 'recovering')
              AND issue.severity_rank <= CASE settings.minimum_severity
                WHEN 'critical' THEN 0
                WHEN 'warning' THEN 1
                ELSE 2
              END
              AND ${AUTO_TRIAGE_SCOPE_SQL('issue', 'settings')}
            ) AS retry_eligible,
            GREATEST(job.updated_at, COALESCE(run.requested_at, job.updated_at)) AS updated_at
       FROM target_auto_triage_jobs job
       JOIN target_issues issue ON issue.id = job.issue_id
       LEFT JOIN target_auto_triage_settings settings ON settings.target_id = job.target_id
       LEFT JOIN sessions session ON session.id = job.session_id
       LEFT JOIN runs run ON run.id = job.run_id
      WHERE job.workspace_id = $1
        AND job.issue_id = ANY($2::text[])
      ORDER BY job.issue_id, job.issue_lifecycle_version DESC, job.updated_at DESC`,
    [workspaceId, issueIds]
  );
  const activity = new Map<string, AutomaticInvestigationSummary>();
  for (const row of result.rows) {
    if (!activity.has(row.issue_id)) {
      activity.set(row.issue_id, mapInvestigation(row, retryPermissions));
    }
  }
  return activity;
}
