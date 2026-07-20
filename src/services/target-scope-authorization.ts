import type { AgentTargetScope } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { TargetType } from '../types/domain.js';
import type { TargetPromptResourceConstraints } from './prompt-resources/providers/target-provider.js';

export const TARGET_DIAGNOSTICS_READ_CAPABILITY = 'target.diagnostics.read';
export const TARGET_REMEDIATION_WRITE_CAPABILITY = 'target.remediation.write';

export interface ExactTargetBinding {
  id: string;
  targetType: TargetType;
}

export function capabilityRequiresExactTarget(capabilityId: string): boolean {
  return capabilityId === TARGET_DIAGNOSTICS_READ_CAPABILITY
    || capabilityId === TARGET_REMEDIATION_WRITE_CAPABILITY;
}

export function targetAllowedByAgentScope(scope: AgentTargetScope, target: ExactTargetBinding): boolean {
  return (!scope.targetTypes?.length || scope.targetTypes.includes(target.targetType))
    && (!scope.targetIds?.length || scope.targetIds.includes(target.id));
}

export function targetAllowedByWorkflowConstraints(
  constraints: TargetPromptResourceConstraints | undefined,
  target: ExactTargetBinding
): boolean {
  return (!constraints?.targetTypes.length || constraints.targetTypes.includes(target.targetType))
    && (!constraints?.targetIds.length || constraints.targetIds.includes(target.id));
}

export function targetAllowedByMapping(mapping: CapabilityRoutingMapping, target: ExactTargetBinding): boolean {
  return (!mapping.targetTypes.length || mapping.targetTypes.includes(target.targetType))
    && (!mapping.targetIds.length || mapping.targetIds.includes(target.id));
}
