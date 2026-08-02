import type { AgentTargetAccessPolicy } from '../types/agents.js';

export const DEFAULT_AGENT_TARGET_ACCESS_POLICY: AgentTargetAccessPolicy = {
  mode: 'all',
  targetIds: []
};

export function normalizeAgentTargetAccessPolicy(
  policy: AgentTargetAccessPolicy | null | undefined = DEFAULT_AGENT_TARGET_ACCESS_POLICY
): AgentTargetAccessPolicy {
  const mode = policy?.mode === 'allowlist' || policy?.mode === 'denylist'
    ? policy.mode
    : 'all';
  const targetIds = Array.isArray(policy?.targetIds)
    ? policy.targetIds.filter((targetId): targetId is string => typeof targetId === 'string')
    : [];
  return {
    mode,
    targetIds: mode === 'all'
      ? []
      : [...new Set(targetIds.map((targetId) => targetId.trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right))
  };
}

export function targetAllowedByAgentPolicy(
  policy: AgentTargetAccessPolicy | undefined,
  targetId: string
): boolean {
  const normalized = normalizeAgentTargetAccessPolicy(policy);
  if (normalized.mode === 'all') return true;
  const selected = normalized.targetIds.includes(targetId);
  return normalized.mode === 'allowlist' ? selected : !selected;
}
