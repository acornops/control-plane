export const DELEGATE_SPECIALIST_FUNCTION = '_acornops_delegate_specialist';
export const AWAIT_DELEGATIONS_FUNCTION = '_acornops_await_delegations';

export const COORDINATOR_FUNCTIONS = [
  DELEGATE_SPECIALIST_FUNCTION,
  AWAIT_DELEGATIONS_FUNCTION
] as const;

export const DEFAULT_MAX_CONCURRENT_DELEGATIONS = 4;
export const DEFAULT_MAX_DELEGATIONS = 8;

export function clampDelegationLimits(input?: {
  maxConcurrentChildren?: number;
  maxChildren?: number;
}): { maxConcurrentChildren: number; maxChildren: number } {
  const maxChildren = Math.max(1, Math.min(DEFAULT_MAX_DELEGATIONS, input?.maxChildren || DEFAULT_MAX_DELEGATIONS));
  return {
    maxConcurrentChildren: Math.max(
      1,
      Math.min(DEFAULT_MAX_CONCURRENT_DELEGATIONS, input?.maxConcurrentChildren || DEFAULT_MAX_CONCURRENT_DELEGATIONS, maxChildren)
    ),
    maxChildren
  };
}
