import { repo } from '../store/repository.js';
import {
  AUTO_TRIAGE_SYSTEM_PRINCIPAL_ID,
  type AutoTriageEffectiveBehavior,
  type AutoTriageReadinessReason,
  type AutoTriageReadinessStatus,
  type AutoTriageWriteMode,
  type TargetAutoTriageSettingsView
} from '../types/auto-triage.js';
import type { TargetSummary, ToolAccessMode } from '../types/domain.js';
import { resolveInteractiveMcpToolAvailability } from './interactive-mcp-tool-availability.js';
import { resolveTargetRunTools, type TargetRunToolResolution } from './target-run-tool-resolution.js';
import { resolveWorkspaceLlmSettings } from './workspace-ai-resolution.js';

export function requestedAutoTriageToolMode(writeMode: AutoTriageWriteMode): ToolAccessMode {
  return writeMode === 'read_only' ? 'read_only' : 'read_write';
}

export function resolveAutoTriageEffectiveBehavior(
  writeMode: AutoTriageWriteMode,
  resolution: Pick<TargetRunToolResolution, 'targetSupportsWrite' | 'confirmationRequiredForWrite' | 'summary'>
): AutoTriageEffectiveBehavior {
  const requestedToolMode = requestedAutoTriageToolMode(writeMode);
  const hasWriteTools = resolution.targetSupportsWrite && resolution.summary.writeAllowed > 0;
  const effectiveToolMode: ToolAccessMode = requestedToolMode === 'read_write' && hasWriteTools
    ? 'read_write'
    : 'read_only';
  const confirmationRequiredForWrite = effectiveToolMode === 'read_write'
    && (writeMode === 'approval_required' || resolution.confirmationRequiredForWrite);
  const reducedToApproval = writeMode === 'full_write' && confirmationRequiredForWrite;
  const targetCeilingApplied = (requestedToolMode === 'read_write' && effectiveToolMode === 'read_only')
    || reducedToApproval;
  const summary: AutoTriageEffectiveBehavior['summary'] = effectiveToolMode === 'read_only'
    ? requestedToolMode === 'read_write' && !resolution.targetSupportsWrite
      ? 'agent_read_only'
      : 'read_only'
    : reducedToApproval
      ? 'reduced_to_approval'
      : confirmationRequiredForWrite
        ? 'approval_required'
        : 'automatic_write';
  return {
    requestedWriteMode: writeMode,
    effectiveToolMode,
    confirmationRequiredForWrite,
    targetCeilingApplied,
    targetSupportsWrite: resolution.targetSupportsWrite,
    summary
  };
}

export function resolveAutoTriageReadiness(input: {
  credentialConfigured: boolean;
  diagnosticToolCount: number;
  targetStatus: TargetSummary['status'];
  hasBlockingMcpReadiness: boolean;
  unavailableOptionalMcpToolCount: number;
}): {
  status: AutoTriageReadinessStatus;
  reasons: AutoTriageReadinessReason[];
  unavailableOptionalMcpToolCount: number;
} {
  const reasons: AutoTriageReadinessReason[] = [];
  let status: AutoTriageReadinessStatus = 'ready';
  if (!input.credentialConfigured) {
    reasons.push('ai_provider_credentials_missing');
    status = 'needs_setup';
  }
  if (input.diagnosticToolCount === 0) {
    reasons.push('no_diagnostic_tools');
    status = 'needs_setup';
  }
  if (input.hasBlockingMcpReadiness) {
    reasons.push('mcp_tools_need_setup');
    status = 'needs_setup';
  }
  if (input.targetStatus !== 'online' && input.targetStatus !== 'degraded') {
    reasons.push('target_agent_disconnected');
    if (status === 'ready') status = 'temporarily_unavailable';
  }
  if (input.unavailableOptionalMcpToolCount > 0) {
    reasons.push('optional_mcp_tools_unavailable');
  }
  return {
    status,
    reasons,
    unavailableOptionalMcpToolCount: input.unavailableOptionalMcpToolCount
  };
}

export async function resolveTargetAutoTriagePreview(
  target: TargetSummary,
  writeMode: AutoTriageWriteMode
): Promise<{
  effectiveBehavior: AutoTriageEffectiveBehavior;
  readiness: {
    status: AutoTriageReadinessStatus;
    reasons: AutoTriageReadinessReason[];
    unavailableOptionalMcpToolCount: number;
  };
  toolResolution: TargetRunToolResolution;
}> {
  const requestedToolMode = requestedAutoTriageToolMode(writeMode);
  const [llmSettings, rawToolResolution] = await Promise.all([
    resolveWorkspaceLlmSettings(target.workspaceId),
    resolveTargetRunTools({
      workspaceId: target.workspaceId,
      targetId: target.id,
      targetType: target.targetType,
      toolAccessMode: requestedToolMode,
      includeNativeTools: true,
      resyncIfEmpty: false
    })
  ]);
  const availability = await resolveInteractiveMcpToolAvailability({
    workspaceId: target.workspaceId,
    principal: { type: 'service_identity', id: AUTO_TRIAGE_SYSTEM_PRINCIPAL_ID },
    resolution: rawToolResolution
  });
  return {
    effectiveBehavior: resolveAutoTriageEffectiveBehavior(writeMode, availability.resolution),
    readiness: resolveAutoTriageReadiness({
      credentialConfigured: llmSettings.credentialConfigured,
      diagnosticToolCount: availability.resolution.summary.readAllowed,
      targetStatus: target.status,
      hasBlockingMcpReadiness: availability.blockingReadiness !== null,
      unavailableOptionalMcpToolCount: availability.unavailableMcpToolCount
    }),
    toolResolution: availability.resolution
  };
}

export async function getTargetAutoTriageSettingsPreview(
  workspaceId: string,
  targetId: string,
  canEdit: boolean
): Promise<TargetAutoTriageSettingsView | null> {
  const target = await repo.getTarget(workspaceId, targetId);
  if (!target) return null;
  const settings = await repo.autoTriage.getTargetAutoTriageSettings(workspaceId, targetId);
  const [preview, eligibleCurrentIssueCount, queueSummary] = await Promise.all([
    resolveTargetAutoTriagePreview(target, settings.writeMode),
    repo.autoTriage.countEligibleCurrentAutoTriageIssues(workspaceId, targetId, settings.minimumSeverity),
    repo.autoTriage.getTargetAutoTriageQueueSummary(workspaceId, targetId)
  ]);
  return {
    ...settings,
    canEdit,
    eligibleCurrentIssueCount,
    queueSummary,
    effectiveBehavior: preview.effectiveBehavior,
    readiness: preview.readiness
  };
}
