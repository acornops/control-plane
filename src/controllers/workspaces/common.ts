import { LlmGatewayHttpError } from '../../services/mcp-registry-client.js';
import { Role, WorkspaceInvitation, WorkspaceMembership } from '../../types/domain.js';
import { getWorkspacePermissions, isProtectedRole, isSupportedRole, OWNER_ROLE_KEY } from '../../auth/authorization.js';

export function mapGatewayError(err: LlmGatewayHttpError, options?: { upstreamMessage?: string }): {
  status: number;
  body: { error: { code: string; message: string; retryable: boolean } };
} {
  if (err.status === 400) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message,
          retryable: false
        }
      }
    };
  }
  if (err.status === 404) {
    return {
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: err.message,
          retryable: false
        }
      }
    };
  }
  if (err.status === 409) {
    return {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: err.message,
          retryable: false
        }
      }
    };
  }
  if (err.status === 401 || err.status === 403) {
    return {
      status: 502,
      body: {
        error: {
          code: 'UPSTREAM_AUTH_ERROR',
          message: 'llm-gateway rejected control-plane credentials',
          retryable: false
        }
      }
    };
  }
  return {
    status: 502,
    body: {
      error: {
        code: 'UPSTREAM_ERROR',
        message: options?.upstreamMessage || 'Failed to synchronize MCP configuration with llm-gateway',
        retryable: true
      }
    }
  };
}

export function canManageMembership(actorRole: Role, targetRole?: Role, nextRole?: Role): boolean {
  if (!isSupportedRole(actorRole)) {
    return false;
  }
  if (!getWorkspacePermissions(actorRole).manage_members) {
    return false;
  }
  if ((targetRole && !isSupportedRole(targetRole)) || (nextRole && !isSupportedRole(nextRole))) {
    return false;
  }
  if (actorRole === OWNER_ROLE_KEY) {
    return true;
  }
  return !isProtectedRole(targetRole) && !isProtectedRole(nextRole);
}

export function serializeWorkspaceMembership(member: WorkspaceMembership) {
  return {
    workspaceId: member.workspaceId,
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role,
    roleTemplate: member.roleTemplate,
    source: member.source,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt
  };
}

export function serializeWorkspaceInvitation(invitation: WorkspaceInvitation, token?: string) {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    workspaceName: invitation.workspaceName,
    email: invitation.email,
    role: invitation.role,
    roleTemplate: invitation.roleTemplate,
    invitedBy: invitation.invitedBy,
    status: invitation.status,
    acceptedBy: invitation.acceptedBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    ...(token ? { token } : {})
  };
}
