import {
  createTargetMcpServer,
  toPublicMcpServerConfig
} from '../../services/mcp-registry-client.js';
import {
  getInheritedWorkspaceDefault,
  workspaceDefaultIdFromInheritedId
} from '../../services/workspace-default-resolution.js';
import { TargetType } from '../../types/domain.js';
import { recordMcpServerAudit } from './mcp-audit.js';

export async function materializeInheritedTargetMcp(args: {
  serverId: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  actorUserId: string;
  body: Record<string, unknown>;
  value: { enabled?: boolean };
}): Promise<{ status: number; body: unknown } | null> {
  if (!workspaceDefaultIdFromInheritedId(args.serverId)) return null;
  const allowed = ['enabled', 'expectedRevision'];
  if (args.value.enabled !== true || Object.keys(args.body).some((key) => !allowed.includes(key))) {
    return immutable(400, 'A platform default can only be enabled; its source is managed by a platform administrator.');
  }
  const inherited = await getInheritedWorkspaceDefault(
    args.workspaceId,
    args.serverId,
    'mcp_server',
    args.targetType
  );
  if (!inherited || inherited.source.type !== 'https') {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'MCP server not found', retryable: false } } };
  }
  const materialized = await createTargetMcpServer({
    workspaceId: args.workspaceId,
    targetId: args.targetId,
    targetType: args.targetType,
    name: inherited.name,
    url: inherited.source.endpoint,
    enabled: true,
    auth: { type: 'none' },
    credentialMode: 'none'
  });
  await recordMcpServerAudit({
    workspaceId: args.workspaceId,
    targetId: args.targetId,
    targetType: args.targetType,
    eventType: 'mcp.server.created.v1',
    actorUserId: args.actorUserId,
    summary: 'Platform default MCP server enabled',
    server: materialized
  });
  return {
    status: 200,
    body: toPublicMcpServerConfig(materialized)
  };
}

function immutable(status: number, message: string) {
  return {
    status,
    body: { error: { code: 'PLATFORM_DEFAULT_SOURCE_IMMUTABLE', message, retryable: false } }
  };
}
