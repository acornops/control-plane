import { randomUUID } from 'node:crypto';
import { AdminAuthenticatedRequest } from '../auth/admin-token.js';
import { AdminWorkspaceMembershipAudit } from '../store/repository-admin.js';
import { adminAuditEventInput } from './admin-controller-common.js';

export function membershipAudit(req: AdminAuthenticatedRequest, input: {
  action: string;
  workspaceId: string;
  userId: string;
  reason: string;
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
  extraWorkspaceEvents?: AdminWorkspaceMembershipAudit['workspace'];
}): AdminWorkspaceMembershipAudit {
  const correlationId = randomUUID();
  const sharedMetadata = { ...input.metadata, correlationId };
  return {
    admin: adminAuditEventInput(req, {
      action: input.action,
      workspaceId: input.workspaceId,
      subjectType: 'user',
      subjectId: input.userId,
      reason: input.reason,
      metadata: sharedMetadata
    }),
    workspace: [{
      workspaceId: input.workspaceId,
      category: 'membership',
      eventType: input.eventType,
      operation: 'write',
      actorType: 'admin_token',
      actorTokenId: 'platform-admin',
      objectType: 'member',
      objectId: input.userId,
      summary: input.summary,
      metadata: { ...sharedMetadata, actorLabel: 'Platform administrator' }
    }, ...(input.extraWorkspaceEvents || []).map((event) => ({
      ...event,
      actorType: 'admin_token' as const,
      actorTokenId: 'platform-admin',
      metadata: { ...(event.metadata || {}), correlationId, actorLabel: 'Platform administrator' }
    }))]
  };
}
