import type { TargetType } from './domain.js';

export type TargetIssueStatus = 'active' | 'recovering' | 'resolved';
export type TargetIssueSeverity = 'critical' | 'warning' | 'info';

export interface TargetIssue {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  targetName?: string;
  fingerprint: string;
  issueType: string;
  status: TargetIssueStatus;
  severity: TargetIssueSeverity;
  title: string;
  summary: string;
  scopeKind?: string;
  scopeName?: string;
  namespace?: string;
  objectKind?: string;
  objectName?: string;
  reason?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastObservedSnapshotAt: string;
  resolvedAt?: string;
  occurrenceCount: number;
  reopenedCount: number;
  cleanSnapshotCount: number;
  latestEvidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TargetIssueObservation {
  id: string;
  issueId: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  snapshotTs: string;
  findingId?: string;
  severity: TargetIssueSeverity;
  title: string;
  message: string;
  reason?: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}
