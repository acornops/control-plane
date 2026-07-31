import type { PoolClient } from 'pg';

import { db } from '../infra/db.js';
import type { TargetIssue } from '../types/domain.js';
import { incrementAutoTriageQueued } from '../metrics-auto-triage.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';

type Queryable = Pick<typeof db, 'query'> | PoolClient;

export async function requeueDisabledTargetAutoTriageJob(
  client: Queryable,
  issue: Pick<TargetIssue, 'id' | 'workspaceId' | 'targetId' | 'targetType' | 'lifecycleVersion'>,
  settingsRevision: number
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `UPDATE target_auto_triage_jobs
        SET trigger_reason = 'existing_issue_start',
            status = 'queued',
            settings_revision = $3,
            attempt_count = 0,
            next_attempt_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            internal_error_message = NULL,
            updated_at = NOW()
      WHERE issue_id = $1
        AND issue_lifecycle_version = $2
        AND status = 'skipped'
        AND session_created_at IS NULL
        AND error_code IN ('AUTO_TRIAGE_DISABLED', 'ISSUE_NOT_ELIGIBLE')
      RETURNING id`,
    [issue.id, issue.lifecycleVersion, settingsRevision]
  );
  const jobId = result.rows[0]?.id;
  if (!jobId) return false;

  incrementAutoTriageQueued('existing_issue_start');
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
      triggerReason: 'existing_issue_start',
      resumedAfterDisable: true
    }
  }, client);
  return true;
}
