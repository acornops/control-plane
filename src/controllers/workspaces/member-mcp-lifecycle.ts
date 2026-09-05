import type { Response } from 'express';

import { LlmGatewayHttpError } from '../../services/mcp-registry-client.js';
import {
  reconcileCurrentWorkspaceMemberMcpLifecycle,
  reconcileWorkspaceMemberMcpLifecycle
} from '../../services/mcp-user-lifecycle-worker.js';
import { repo } from '../../store/repository.js';
import { mapGatewayError } from './common.js';

export async function retryActiveWorkspaceMemberMcpLifecycle(
  workspaceId: string,
  userId: string
) {
  const retry = await reconcileCurrentWorkspaceMemberMcpLifecycle({
    workspaceId,
    userId,
    status: 'active'
  });
  return retry === 'reconciled' ? repo.getWorkspaceMember(workspaceId, userId) : null;
}

export function retryRemovedWorkspaceMemberMcpLifecycle(workspaceId: string, userId: string) {
  return reconcileCurrentWorkspaceMemberMcpLifecycle({ workspaceId, userId, status: 'removed' });
}

export function reconcileWorkspaceMemberMcpAccess(input: {
  workspaceId: string;
  userId: string;
  membershipGeneration: number;
  status: 'active' | 'removed';
}) {
  return reconcileWorkspaceMemberMcpLifecycle(input);
}

export function reconcileAcceptedWorkspaceMemberMcpLifecycle(input: {
  workspaceId: string;
  userId: string;
  membershipGeneration?: number;
}) {
  return input.membershipGeneration === undefined
    ? reconcileCurrentWorkspaceMemberMcpLifecycle({
        workspaceId: input.workspaceId,
        userId: input.userId,
        status: 'active'
      })
    : reconcileWorkspaceMemberMcpLifecycle({
        workspaceId: input.workspaceId,
        userId: input.userId,
        membershipGeneration: input.membershipGeneration,
        status: 'active'
      });
}

export function handleWorkspaceMemberMcpLifecycleError(
  res: Response,
  error: unknown,
  upstreamMessage: string
): boolean {
  if (!(error instanceof LlmGatewayHttpError)) return false;
  const mapped = mapGatewayError(error, { upstreamMessage });
  res.status(mapped.status).json(mapped.body);
  return true;
}
