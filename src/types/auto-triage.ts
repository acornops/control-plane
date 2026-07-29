import type { TargetIssueSeverity } from './target-issues.js';
import type { TargetType, ToolAccessMode } from './domain.js';

export const AUTO_TRIAGE_SYSTEM_PRINCIPAL_ID = 'system-auto-triage';

export type AutoTriageMinimumSeverity = TargetIssueSeverity;
export type AutoTriageWriteMode =
  | 'follow_target'
  | 'read_only'
  | 'approval_required'
  | 'full_write';
export type AutoTriageReadinessStatus = 'ready' | 'needs_setup' | 'temporarily_unavailable';
export type AutoTriageReadinessReason =
  | 'ai_provider_credentials_missing'
  | 'target_agent_disconnected'
  | 'no_diagnostic_tools'
  | 'mcp_tools_need_setup'
  | 'optional_mcp_tools_unavailable';
export type AutoTriageJobTriggerReason =
  | 'created'
  | 'reopened'
  | 'severity_escalated'
  | 'existing_issue_start'
  | 'retry';
export type AutoTriageJobStatus =
  | 'queued'
  | 'processing'
  | 'blocked'
  | 'started'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface TargetAutoTriageSettings {
  workspaceId: string;
  targetId: string;
  enabled: boolean;
  minimumSeverity: AutoTriageMinimumSeverity;
  writeMode: AutoTriageWriteMode;
  additionalInstructions: string;
  revision: number;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AutoTriageEffectiveBehavior {
  requestedWriteMode: AutoTriageWriteMode;
  effectiveToolMode: ToolAccessMode;
  confirmationRequiredForWrite: boolean;
  targetCeilingApplied: boolean;
  targetSupportsWrite: boolean;
  summary:
    | 'read_only'
    | 'approval_required'
    | 'automatic_write'
    | 'reduced_to_approval'
    | 'agent_read_only';
}

export interface TargetAutoTriageSettingsView extends TargetAutoTriageSettings {
  canEdit: boolean;
  eligibleCurrentIssueCount: number;
  queueSummary: TargetAutoTriageQueueSummary;
  effectiveBehavior: AutoTriageEffectiveBehavior;
  readiness: {
    status: AutoTriageReadinessStatus;
    reasons: AutoTriageReadinessReason[];
    unavailableOptionalMcpToolCount: number;
  };
}

export interface TargetAutoTriageQueueSummary {
  activeCount: number;
  waitingCount: number;
  oldestWaitingAt?: string;
}

export interface AutoTriageRuntimeMetricsSnapshot {
  activeRuns: number;
  queued: number;
  blocked: number;
  processing: number;
  started: number;
  stopping: number;
  oldestWaitingAgeSeconds: number;
}

export interface TargetAutoTriageJob {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  issueId: string;
  issueLifecycleVersion: number;
  triggerReason: AutoTriageJobTriggerReason;
  status: AutoTriageJobStatus;
  settingsRevision: number;
  sessionId?: string;
  runId?: string;
  retryGeneration: number;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: string;
  internalErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomaticInvestigationSummary {
  issueId: string;
  lifecycleVersion: number;
  state:
    | 'queued'
    | 'investigating'
    | 'awaiting_approval'
    | 'findings_ready'
    | 'failed'
    | 'cancelled'
    | 'deleted';
  sessionId?: string;
  runId?: string;
  updatedAt: string;
  errorCode?: string;
  canRetry: boolean;
}

export interface AutomaticInvestigationSessionContext {
  issueId: string;
  lifecycleVersion: number;
  severity: TargetIssueSeverity;
  scopeKind?: string;
  scopeName?: string;
  objectKind?: string;
  objectName?: string;
  writeMode: AutoTriageWriteMode;
  effectiveToolMode: ToolAccessMode;
  confirmationRequiredForWrite: boolean;
}
