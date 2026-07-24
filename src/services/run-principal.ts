import { getWorkspacePermissions, isSupportedRole } from '../auth/authorization.js';
import { getWorkspaceAuthorizationForUser } from '../auth/workspace-authorization.js';
import { db } from '../infra/db.js';
import type { AgentAccessActor, RunPrincipalRef } from '../types/agents.js';

export async function resolveRunPrincipal(
  workspaceId: string,
  principal: RunPrincipalRef
): Promise<AgentAccessActor | null> {
  if (principal.type === 'user') {
    const authz = await getWorkspaceAuthorizationForUser(principal.id, workspaceId);
    if (!authz) return null;
    return { userId: principal.id, role: authz.role, permissions: authz.permissions };
  }

  const result = await db.query<{ id: string; role: string }>(
    `SELECT id,role FROM service_identities
     WHERE workspace_id=$1 AND id=$2 AND status='active'`,
    [workspaceId, principal.id]
  );
  const identity = result.rows[0];
  if (!identity || !isSupportedRole(identity.role)) return null;
  return {
    userId: identity.id,
    role: identity.role,
    permissions: getWorkspacePermissions(identity.role)
  };
}
