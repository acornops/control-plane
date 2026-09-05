import type { TargetType } from '../types/domain.js';

export type McpDestination =
  | { kind: 'agent'; id: string }
  | { kind: 'target'; id: string; targetType: TargetType };

export function buildGatewayMcpDestinationQuery(
  workspaceId: string,
  destination: McpDestination
): URLSearchParams {
  return destination.kind === 'agent'
    ? new URLSearchParams({
      workspace_id: workspaceId,
      scope_type: 'agent',
      agent_id: destination.id
    })
    : new URLSearchParams({
      workspace_id: workspaceId,
      scope_type: 'target',
      target_id: destination.id,
      target_type: destination.targetType
    });
}
