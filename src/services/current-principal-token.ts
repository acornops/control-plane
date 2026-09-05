import type { RunScopeClaims } from './run-scope-claims.js';
import { gatewayTokenService } from './token-service.js';
import { withCurrentWorkspaceMemberMcpGenerationLock } from '../store/repository-mcp-user-lifecycle.js';

export type CurrentPrincipalTokenResult =
  | { current: true; token: string }
  | { current: false };

/**
 * Signs a user token while holding shared locks on the membership and lifecycle
 * rows. A concurrent removal cannot commit until signing completes, so every
 * issued user token is either pre-removal and TTL-bounded or rejected as stale.
 */
export async function signRunScopeTokenForCurrentPrincipal(
  claims: RunScopeClaims
): Promise<CurrentPrincipalTokenResult> {
  const principal = claims.principal;
  if (!principal) return { current: false };
  if (principal.type === 'service_identity') {
    return { current: true, token: await gatewayTokenService.signRunScopeToken(claims) };
  }
  const membershipGeneration = principal.membershipGeneration;
  if (!Number.isSafeInteger(membershipGeneration) || membershipGeneration! <= 0) {
    return { current: false };
  }
  const result = await withCurrentWorkspaceMemberMcpGenerationLock(
    claims.workspaceId,
    principal.id,
    membershipGeneration!,
    () => gatewayTokenService.signRunScopeToken(claims)
  );
  return result.current
    ? { current: true, token: result.value }
    : { current: false };
}
