import type { AssistantReference } from '../types/assistant-references.js';
import type { RunPrincipalRef } from '../types/agents.js';
import { AUTO_TRIAGE_SYSTEM_PRINCIPAL_ID } from '../types/auto-triage.js';
import {
  omitTargetRunMcpTools,
  remoteMcpToolRefs,
  type TargetRunToolResolution
} from './target-run-tool-resolution.js';
import {
  boundedPublicMcpReadinessReportForFailures,
  getExactMcpReadinessReportForToolFiltering,
  isDegradableInteractiveMcpFailure,
  type McpReadinessReport
} from './workflow-readiness.js';

export interface InteractiveMcpToolAvailability {
  resolution: TargetRunToolResolution;
  unavailableMcpToolCount: number;
  blockingReadiness: McpReadinessReport | null;
}

export function isMcpFailureUnavailableForInteractivePrincipal(
  principal: RunPrincipalRef,
  failure: McpReadinessReport['failures'][number]
): boolean {
  return isDegradableInteractiveMcpFailure(failure)
    || (
      principal.type === 'service_identity'
      && principal.id === AUTO_TRIAGE_SYSTEM_PRINCIPAL_ID
      && failure.code === 'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED'
    );
}

export async function resolveInteractiveMcpToolAvailability(input: {
  workspaceId: string;
  principal: RunPrincipalRef;
  resolution: TargetRunToolResolution;
  assistantReferences?: AssistantReference[];
}): Promise<InteractiveMcpToolAvailability> {
  const readiness = await getExactMcpReadinessReportForToolFiltering(
    input.workspaceId,
    input.principal,
    remoteMcpToolRefs(input.resolution)
  );
  const explicitlyReferencedToolRefs = new Set(
    (input.assistantReferences || [])
      .flatMap((reference) => reference.kind === 'tool' && reference.serverId && reference.toolName
        ? [`${reference.serverId}\u0000${reference.toolName}`]
        : [])
  );
  const isUnavailableForThisPrincipal = (failure: McpReadinessReport['failures'][number]) =>
    isMcpFailureUnavailableForInteractivePrincipal(input.principal, failure);
  const blockingFailures = readiness.failures.filter((failure) => (
    !isUnavailableForThisPrincipal(failure)
    || explicitlyReferencedToolRefs.has(`${failure.serverId}\u0000${failure.toolName}`)
  ));
  const unavailableFailures = readiness.failures.filter(isUnavailableForThisPrincipal);
  return {
    resolution: omitTargetRunMcpTools(input.resolution, unavailableFailures),
    unavailableMcpToolCount: unavailableFailures.length,
    blockingReadiness: blockingFailures.length > 0
      ? boundedPublicMcpReadinessReportForFailures(blockingFailures)
      : null
  };
}
