import {
  getActiveWorkspaceMemberMcpGeneration,
  getWorkspaceMemberMcpLifecycle
} from '../store/repository-mcp-user-lifecycle.js';
import type { RunPrincipalRef } from '../types/agents.js';
import { reconcileWorkspaceMemberMcpLifecycle } from './mcp-user-lifecycle-worker.js';
import { createMcpUserLifecycleStaleError } from './llm-gateway-admin-client.js';

type McpUserPrincipalResolver = (
  workspaceId: string,
  userId: string
) => Promise<RunPrincipalRef>;

let resolverOverrideForTests: McpUserPrincipalResolver | undefined;

export function configureMcpUserPrincipalResolverForTests(
  resolver?: McpUserPrincipalResolver
): void {
  resolverOverrideForTests = resolver;
}

export async function resolveMcpUserPrincipal(
  workspaceId: string,
  userId: string
): Promise<RunPrincipalRef> {
  if (resolverOverrideForTests) return resolverOverrideForTests(workspaceId, userId);
  let membershipGeneration = await getActiveWorkspaceMemberMcpGeneration(workspaceId, userId);
  if (membershipGeneration === null) {
    const lifecycle = await getWorkspaceMemberMcpLifecycle(workspaceId, userId);
    if (lifecycle?.status !== 'active') {
      throw createMcpUserLifecycleStaleError(
        'Workspace membership MCP lifecycle state is missing or no longer active.'
      );
    }
    await reconcileWorkspaceMemberMcpLifecycle({
      workspaceId,
      userId,
      membershipGeneration: lifecycle.membershipGeneration,
      status: 'active'
    });
    membershipGeneration = await getActiveWorkspaceMemberMcpGeneration(workspaceId, userId);
  }
  if (membershipGeneration === null) {
    throw createMcpUserLifecycleStaleError(
      'Workspace membership MCP lifecycle activation changed before the request completed.'
    );
  }
  return {
    type: 'user',
    id: userId,
    membershipGeneration
  };
}
