import type { Response } from 'express';

import {
  reconcileCurrentWorkspaceMemberMcpLifecycle,
  reconcileWorkspaceMemberMcpLifecycle
} from '../services/mcp-user-lifecycle-worker.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { repo } from '../store/repository.js';
import { mapGatewayError } from './workspaces/common.js';

export async function retryActiveAdminMemberMcpLifecycle(
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

export function retryRemovedAdminMemberMcpLifecycle(workspaceId: string, userId: string) {
  return reconcileCurrentWorkspaceMemberMcpLifecycle({ workspaceId, userId, status: 'removed' });
}

export function reconcileAdminMemberMcpLifecycle(input: {
  workspaceId: string;
  userId: string;
  membershipGeneration: number;
  status: 'active' | 'removed';
}) {
  return reconcileWorkspaceMemberMcpLifecycle(input);
}

export function handleAdminMemberMcpLifecycleError(
  res: Response,
  error: unknown,
  upstreamMessage: string
): boolean {
  if (!(error instanceof LlmGatewayHttpError)) return false;
  const mapped = mapGatewayError(error, { upstreamMessage });
  res.status(mapped.status).json(mapped.body);
  return true;
}
