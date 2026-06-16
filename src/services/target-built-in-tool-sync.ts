import { agentGateway } from '../agent/ws-server.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import {
  createTargetMcpServer,
  listTargetMcpServers,
  listTargetMcpTools,
  updateTargetMcpServer
} from './mcp-registry-client.js';
import { webhooks } from './webhooks.js';

export interface BuiltInToolSyncResult {
  ok: boolean;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  discoveredToolCount: number;
  registeredToolCount: number;
  addedTools: string[];
  removedTools: string[];
  error?: string;
}

function normalizeCapability(value: unknown): 'read' | 'write' {
  return value === 'read' ? 'read' : 'write';
}

function targetWebhookScope(targetId: string, targetType: TargetType): {
  clusterId?: string;
  targetId: string;
  targetType: TargetType;
} {
  return {
    ...(targetType === KUBERNETES_TARGET_TYPE ? { clusterId: targetId } : {}),
    targetId,
    targetType
  };
}

function countRegisteredTools(tools: Array<{ name: string }>, expectedNames: Set<string>): number {
  return tools.filter((tool) => expectedNames.has(tool.name)).length;
}

export async function syncTargetBuiltInTools(
  workspaceId: string,
  targetId: string,
  targetType: TargetType
): Promise<BuiltInToolSyncResult> {
  try {
    const discoveredTools = await agentGateway.listAgentTools(targetId);
    const servers = await listTargetMcpServers(workspaceId, targetId, targetType);
    const existing = servers.find(
      (server) => server.server_name === config.BUILTIN_MCP_SERVER_NAME || server.server_url === config.BUILTIN_MCP_SERVER_URL
    );

    const builtinTools = discoveredTools.map((tool) => ({
      name: tool.name,
      timeoutMs: tool.timeout_ms || config.AGENT_TOOL_DEFAULT_TIMEOUT_MS,
      description: tool.description,
      capability: normalizeCapability(tool.capability),
      version: typeof tool.version === 'string' && tool.version.length > 0 ? tool.version : 'v1',
      source: 'builtin' as const,
      inputSchema: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : undefined,
      enabled: true
    }));

    const existingTools = await listTargetMcpTools(workspaceId, targetId, targetType);
    const existingBuiltinNames = new Set(existingTools.filter((tool) => tool.source === 'builtin').map((tool) => tool.name));
    const discoveredNames = new Set(discoveredTools.map((tool) => tool.name));
    const removeTools = [...existingBuiltinNames].filter((name) => !discoveredNames.has(name));

    if (!existing) {
      const created = await createTargetMcpServer({
        workspaceId,
        targetId,
        targetType,
        name: config.BUILTIN_MCP_SERVER_NAME,
        url: config.BUILTIN_MCP_SERVER_URL,
        enabled: true,
        auth: { type: 'none' },
        tools: builtinTools
      });
      webhooks.emit({
        type: 'tool.catalog.changed.v1',
        workspaceId,
        ...targetWebhookScope(targetId, targetType),
        subject: { type: targetType === KUBERNETES_TARGET_TYPE ? 'cluster' : 'target', id: targetId },
        data: {
          reason: 'builtin_tool_sync',
          serverName: config.BUILTIN_MCP_SERVER_NAME,
          addedTools: [...discoveredNames],
          removedTools: []
        }
      });
      logger.info(
        {
          workspaceId,
          targetId,
          targetType,
          discoveredToolCount: builtinTools.length,
          registeredToolCount: countRegisteredTools(created.tools, discoveredNames),
          addedToolCount: discoveredNames.size,
          removedToolCount: 0
        },
        'Synchronized built-in target tools'
      );
      return {
        ok: true,
        workspaceId,
        targetId,
        targetType,
        discoveredToolCount: builtinTools.length,
        registeredToolCount: countRegisteredTools(created.tools, discoveredNames),
        addedTools: [...discoveredNames],
        removedTools: []
      };
    }

    const updated = await updateTargetMcpServer({
      workspaceId,
      targetId,
      targetType,
      serverId: existing.id,
      name: config.BUILTIN_MCP_SERVER_NAME,
      enabled: existing.enabled,
      auth: { type: 'none' },
      tools: builtinTools,
      removeTools
    });
    const addedTools = [...discoveredNames].filter((name) => !existingBuiltinNames.has(name));
    if (addedTools.length > 0 || removeTools.length > 0) {
      webhooks.emit({
        type: 'tool.catalog.changed.v1',
        workspaceId,
        ...targetWebhookScope(targetId, targetType),
        subject: { type: targetType === KUBERNETES_TARGET_TYPE ? 'cluster' : 'target', id: targetId },
        data: {
          reason: 'builtin_tool_sync',
          serverId: existing.id,
          serverName: config.BUILTIN_MCP_SERVER_NAME,
          addedTools,
          removedTools: removeTools
        }
      });
    }
    logger.info(
      {
        workspaceId,
        targetId,
        targetType,
        discoveredToolCount: builtinTools.length,
        registeredToolCount: countRegisteredTools(updated.tools, discoveredNames),
        addedToolCount: addedTools.length,
        removedToolCount: removeTools.length
      },
      'Synchronized built-in target tools'
    );
    return {
      ok: true,
      workspaceId,
      targetId,
      targetType,
      discoveredToolCount: builtinTools.length,
      registeredToolCount: countRegisteredTools(updated.tools, discoveredNames),
      addedTools,
      removedTools: removeTools
    };
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, err }, 'Failed synchronizing built-in target tools');
    return {
      ok: false,
      workspaceId,
      targetId,
      targetType,
      discoveredToolCount: 0,
      registeredToolCount: 0,
      addedTools: [],
      removedTools: [],
      error: err instanceof Error ? err.message : 'Built-in tool sync failed'
    };
  }
}
