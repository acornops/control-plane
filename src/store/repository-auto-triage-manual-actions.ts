import { db } from '../infra/db.js';
import type { TargetAutoTriageJob } from '../types/auto-triage.js';
import type { TargetIssue } from '../types/domain.js';
import {
  enqueueTargetAutoTriageJob,
  getTargetAutoTriageJobForIssueLifecycle
} from './repository-auto-triage.js';
import { withTransaction } from './repository-transaction.js';

export async function startSingleTargetAutoTriageIssue(
  issue: TargetIssue,
  settingsRevision: number
): Promise<TargetAutoTriageJob | null> {
  return withTransaction(async (client) => {
    const eligible = await client.query(
      `SELECT issue.id
         FROM target_issues issue
         JOIN target_auto_triage_settings settings
           ON settings.workspace_id = issue.workspace_id
          AND settings.target_id = issue.target_id
        WHERE issue.workspace_id = $1
          AND issue.id = $2
          AND issue.target_id = $3
          AND issue.lifecycle_version = $4
          AND issue.status IN ('active', 'recovering')
          AND settings.enabled = TRUE
          AND settings.revision = $5
          AND issue.severity_rank <= CASE settings.minimum_severity
                WHEN 'critical' THEN 0
                WHEN 'warning' THEN 1
                ELSE 2
              END
        FOR UPDATE OF issue, settings`,
      [
        issue.workspaceId,
        issue.id,
        issue.targetId,
        issue.lifecycleVersion,
        settingsRevision
      ]
    );
    if (!eligible.rowCount) return null;

    await enqueueTargetAutoTriageJob(
      client,
      issue,
      'existing_issue_start',
      settingsRevision
    );
    const job = await getTargetAutoTriageJobForIssueLifecycle(
      issue.workspaceId,
      issue.id,
      issue.lifecycleVersion,
      client
    );
    if (!job) throw new Error('Automatic investigation job was not persisted');
    return job;
  });
}

export async function skipUnstartedTargetAutoTriageJobs(
  workspaceId: string,
  targetId: string
): Promise<Array<{
  id: string;
  issueId: string;
  issueLifecycleVersion: number;
  targetType: TargetIssue['targetType'];
}>> {
  const result = await db.query<{
    id: string;
    issue_id: string;
    issue_lifecycle_version: number | string;
    target_type: TargetIssue['targetType'];
  }>(
    `UPDATE target_auto_triage_jobs
        SET status = 'skipped',
            error_code = 'AUTO_TRIAGE_DISABLED',
            internal_error_message = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE workspace_id = $1
        AND target_id = $2
        AND run_id IS NULL
        AND status IN ('queued', 'processing', 'blocked')
      RETURNING id, issue_id, issue_lifecycle_version, target_type`,
    [workspaceId, targetId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    issueLifecycleVersion: Number(row.issue_lifecycle_version),
    targetType: row.target_type
  }));
}
