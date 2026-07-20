import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { TargetType } from '../../types/domain.js';

interface McpServerAuditInput {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  actorUserId: string;
  eventType: 'mcp.server.created.v1' | 'mcp.server.updated.v1';
  summary: string;
  server: {
    id: string;
    server_name: string;
    enabled: boolean;
    credential_mode: 'none' | 'workspace' | 'individual';
    tools: unknown[];
  };
}

export async function recordMcpServerAudit(input: McpServerAuditInput): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: input.workspaceId,
    category: 'mcp',
    eventType: input.eventType,
    operation: 'write',
    actorUserId: input.actorUserId,
    objectType: 'mcp_server',
    objectId: input.server.id,
    objectName: input.server.server_name,
    summary: input.summary,
    metadata: {
      targetId: input.targetId,
      targetType: input.targetType,
      enabled: input.server.enabled,
      credentialMode: input.server.credential_mode,
      toolCount: input.server.tools.length
    }
  });
}

export async function recordMcpServerDeletedAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  serverId: string
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'mcp',
    eventType: 'mcp.server.deleted.v1',
    operation: 'write',
    actorUserId,
    objectType: 'mcp_server',
    objectId: serverId,
    summary: 'MCP server deleted',
    metadata: { targetId, targetType, credentialCleanup: 'completed' }
  });
}

export async function recordMcpConnectionCleanupAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  serverId: string
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'mcp',
    eventType: 'mcp.connections_cleanup_completed.v1',
    operation: 'write',
    actorUserId,
    objectType: 'mcp_server',
    objectId: serverId,
    summary: 'MCP credentials cleaned up during uninstall',
    metadata: { targetId, targetType, credentialCleanup: 'completed' }
  });
}

export async function recordMcpTrustChangeInvalidationAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  serverId: string,
  changedFields: string[]
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'mcp',
    eventType: 'mcp.connections_invalidated.v1',
    operation: 'write',
    actorUserId,
    objectType: 'mcp_server',
    objectId: serverId,
    summary: 'MCP connections invalidated after trust-boundary change',
    metadata: { targetId, targetType, changedFields }
  });
}

export async function recordMcpServerTestAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  serverId: string,
  testResult: {
    server_name: string;
    connection_status: 'ok' | 'error';
    discovered_tool_count: number;
    error?: string | null;
  }
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'mcp',
    eventType: 'mcp.server.tested.v1',
    operation: 'read',
    actorUserId,
    objectType: 'mcp_server',
    objectId: serverId,
    objectName: testResult.server_name,
    summary: 'MCP server connection tested',
    metadata: {
      targetId,
      targetType,
      connectionStatus: testResult.connection_status,
      discoveredToolCount: testResult.discovered_tool_count,
      hasError: Boolean(testResult.error)
    }
  });
}

export async function recordToolCatalogAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  toolName: string,
  enabled: boolean,
  capability: 'read' | 'write'
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'tool',
    eventType: 'tool.catalog.changed.v1',
    operation: 'write',
    actorUserId,
    objectType: 'tool',
    objectId: toolName,
    objectName: toolName,
    summary: 'Tool enablement changed',
    metadata: { targetId, targetType, enabled, capability }
  });
}

export async function recordNativeToolSettingAudit(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  actorUserId: string,
  toolId: string,
  enabled: boolean,
  config: Record<string, unknown>
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId,
    category: 'tool',
    eventType: 'tool.catalog.changed.v1',
    operation: 'write',
    actorUserId,
    objectType: 'tool',
    objectId: toolId,
    objectName: toolId,
    summary: 'Built-in tool setting changed',
    metadata: { targetId, targetType, enabled, config }
  });
}
