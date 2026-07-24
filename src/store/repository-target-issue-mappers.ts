import type {
  TargetIssue,
  TargetIssueObservation,
  TargetIssueSeverity,
  TargetIssueStatus,
  TargetType
} from '../types/domain.js';
import { toIso } from './repository-mappers.js';

export interface TargetIssueDbRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  target_name?: string;
  fingerprint: string;
  issue_type: string;
  status: TargetIssueStatus;
  severity: TargetIssueSeverity;
  severity_rank: number;
  title: string;
  summary: string;
  scope_kind: string | null;
  scope_name: string | null;
  object_kind: string | null;
  object_name: string | null;
  reason: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  last_observed_snapshot_at: Date | string;
  resolved_at: Date | string | null;
  occurrence_count: number | string;
  reopened_count: number | string;
  clean_snapshot_count: number | string;
  lifecycle_version: number | string;
  latest_evidence: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TargetIssueObservationDbRow {
  id: string;
  issue_id: string;
  workspace_id: string;
  target_id: string;
  target_type: TargetType;
  snapshot_ts: Date | string;
  finding_id: string | null;
  severity: TargetIssueSeverity;
  title: string;
  message: string;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  created_at: Date | string;
}

export function mapIssueRow(row: TargetIssueDbRow): TargetIssue {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    targetName: row.target_name,
    fingerprint: row.fingerprint,
    issueType: row.issue_type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    scopeKind: row.scope_kind || undefined,
    scopeName: row.scope_name || undefined,
    namespace: row.scope_name || undefined,
    objectKind: row.object_kind || undefined,
    objectName: row.object_name || undefined,
    reason: row.reason || undefined,
    firstSeenAt: toIso(row.first_seen_at)!,
    lastSeenAt: toIso(row.last_seen_at)!,
    lastObservedSnapshotAt: toIso(row.last_observed_snapshot_at)!,
    resolvedAt: toIso(row.resolved_at),
    occurrenceCount: Number(row.occurrence_count),
    reopenedCount: Number(row.reopened_count),
    cleanSnapshotCount: Number(row.clean_snapshot_count),
    lifecycleVersion: Number(row.lifecycle_version || 0),
    latestEvidence: row.latest_evidence || {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapObservationRow(row: TargetIssueObservationDbRow): TargetIssueObservation {
  return {
    id: row.id,
    issueId: row.issue_id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    snapshotTs: toIso(row.snapshot_ts)!,
    findingId: row.finding_id || undefined,
    severity: row.severity,
    title: row.title,
    message: row.message,
    reason: row.reason || undefined,
    evidence: row.evidence || {},
    createdAt: toIso(row.created_at)!
  };
}
