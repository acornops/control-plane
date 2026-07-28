import { db } from '../infra/db.js';
import type {
  AutomaticInvestigationSummary,
  AutoTriageJobStatus,
  AutoTriageWriteMode
} from '../types/auto-triage.js';
import type { TargetIssueSeverity } from '../types/domain.js';
import { toIso } from './repository-mappers.js';

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
      WHERE issue.workspace_id = $1
        AND issue.target_id = $2
        AND issue.status IN ('active', 'recovering')
        AND issue.severity_rank <= $3
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
               AND job.error_code = 'AUTO_TRIAGE_DISABLED'
          )
        )`,
    [workspaceId, targetId, severityRank(minimumSeverity)]
  );
  return Number(result.rows[0]?.count || 0);
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
