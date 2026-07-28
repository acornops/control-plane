import type {
  AutoTriageJobStatus,
  AutoTriageJobTriggerReason,
  TargetAutoTriageJob
} from '../types/auto-triage.js';
import type { TargetType } from '../types/domain.js';
import { toIso } from './repository-mappers.js';

export interface AutoTriageJobRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  issue_id: string;
  issue_lifecycle_version: number | string;
  trigger_reason: AutoTriageJobTriggerReason;
  status: AutoTriageJobStatus;
  settings_revision: number | string;
  session_id: string | null;
  session_created_at: Date | string | null;
  run_id: string | null;
  retry_generation: number | string;
  attempt_count: number | string;
  next_attempt_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  error_code: string | null;
  internal_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function mapAutoTriageJob(row: AutoTriageJobRow): TargetAutoTriageJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    issueId: row.issue_id,
    issueLifecycleVersion: Number(row.issue_lifecycle_version),
    triggerReason: row.trigger_reason,
    status: row.status,
    settingsRevision: Number(row.settings_revision),
    sessionId: row.session_id || undefined,
    runId: row.run_id || undefined,
    retryGeneration: Number(row.retry_generation),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: toIso(row.next_attempt_at)!,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: toIso(row.lease_expires_at),
    errorCode: row.error_code || undefined,
    internalErrorMessage: row.internal_error_message || undefined,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}
