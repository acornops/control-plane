import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import type { TargetIssue } from '../types/domain.js';
import type { AutoTriageJobTriggerReason } from '../types/auto-triage.js';
import { incrementAutoTriageQueued } from '../metrics-auto-triage.js';
import { insertWorkspaceAuditEvent } from './repository-audit-events.js';
import { requeueDisabledTargetAutoTriageJob } from './repository-auto-triage-requeue.js';
import { reserveRunCapacity, lockActiveWorkspace, WorkspaceCapacityError } from './repository-run-capacity.js';
import { withTransaction } from './repository-transaction.js';
type Queryable = Pick<typeof db, 'query'> | PoolClient;

export async function enqueueTargetAutoTriageJob(
  client: Queryable,
  issue: Pick<TargetIssue, 'id' | 'workspaceId' | 'targetId' | 'targetType' | 'lifecycleVersion'>,
  triggerReason: AutoTriageJobTriggerReason,
  settingsRevision: number
): Promise<boolean> {
  if (client === db) return withTransaction((transaction) => enqueueTargetAutoTriageJob(transaction, issue, triggerReason, settingsRevision));
  await lockActiveWorkspace(client, issue.workspaceId);
  if (
    triggerReason === 'existing_issue_start'
    && await requeueDisabledTargetAutoTriageJob(client, issue, settingsRevision)
  ) {
    return true;
  }

  const prior = await client.query('SELECT id FROM target_auto_triage_jobs WHERE issue_id=$1 AND issue_lifecycle_version=$2', [issue.id, issue.lifecycleVersion]);
  if (prior.rowCount) return false;

  const jobId = randomUUID();
  const reservedRunId = randomUUID();
  let capacityDenied = false;
  try {
    await reserveRunCapacity(client, { workspaceId: issue.workspaceId, runId: reservedRunId, pool: 'autoTriage' });
  } catch (error) {
    if (!(error instanceof WorkspaceCapacityError) || error.code !== 'WORKSPACE_OUTSTANDING_RUN_LIMIT') throw error;
    capacityDenied = true;
  }
  const result = await client.query(
    `INSERT INTO target_auto_triage_jobs (
       id, workspace_id, target_id, target_type, issue_id, issue_lifecycle_version,
       trigger_reason, status, settings_revision, reserved_run_id, error_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$10,$8,$9,$11)
     ON CONFLICT (issue_id, issue_lifecycle_version) DO NOTHING`,
    [
      jobId,
      issue.workspaceId,
      issue.targetId,
      issue.targetType,
      issue.id,
      issue.lifecycleVersion,
      triggerReason,
      settingsRevision,
      capacityDenied ? null : reservedRunId,
      capacityDenied ? 'skipped' : 'queued',
      capacityDenied ? 'WORKSPACE_OUTSTANDING_RUN_LIMIT' : null
    ]
  );
  const inserted = (result.rowCount ?? 0) > 0;
  if (inserted && !capacityDenied) {
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
  return inserted && !capacityDenied;
}
