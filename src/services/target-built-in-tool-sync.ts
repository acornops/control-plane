import { agentGateway } from '../agent/ws-server.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementDuplicateBuiltInServerAnomaly } from '../metrics.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import {
  isMcpLifecycleFencedError,
  listTargetMcpServers,
  listTargetMcpTools,
  syncBuiltInMcpServer
} from './mcp-registry-client.js';
import { isReservedInternalToolName } from './internal-tool-names.js';
import { targetWebhookScope } from './target-webhook-scope.js';
import { sanitizeToolInputSchema } from './tool-metadata.js';
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
  terminal?: boolean;
  error?: string;
}

function normalizeCapability(value: unknown): 'read' | 'write' {
  return value === 'read' ? 'read' : 'write';
}

function targetAgentResultContract(tool: {
  name: string;
  outputSchema?: Record<string, unknown>;
  artifactPolicy?: 'never' | 'if_detailed' | 'always';
}): { outputSchema: Record<string, unknown>; artifactPolicy: 'never' | 'if_detailed' | 'always' } {
  if (!tool.outputSchema || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema)) {
    throw new Error(`Target agent tool '${tool.name}' is missing a valid output schema`);
  }
  const artifactPolicy = tool.artifactPolicy;
  if (artifactPolicy !== 'never' && artifactPolicy !== 'if_detailed' && artifactPolicy !== 'always') {
    throw new Error(`Target agent tool '${tool.name}' has an invalid artifact policy`);
  }
  return {
    outputSchema: sanitizeToolInputSchema(tool.outputSchema),
    artifactPolicy,
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
    const builtinTools = discoveredTools
      .filter((tool) => {
        if (!isReservedInternalToolName(tool.name)) return true;
        logger.warn({ workspaceId, targetId, targetType, toolName: tool.name }, 'Skipping reserved internal built-in tool name during sync');
        return false;
      })
      .map((tool) => {
        if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
          throw new Error(`Target agent tool '${tool.name}' is missing a valid input schema`);
        }
        const resultContract = targetAgentResultContract(tool);
        const capability = normalizeCapability(tool.capability);
        return {
          name: tool.name,
          timeoutMs: tool.timeout_ms || config.ASSISTANT_TOOL_DEFAULT_TIMEOUT_MS,
          description: tool.description,
          capability,
          version: typeof tool.version === 'string' && tool.version.length > 0 ? tool.version : 'v1',
          source: 'builtin' as const,
          inputSchema: sanitizeToolInputSchema(tool.inputSchema),
          outputSchema: resultContract.outputSchema,
          artifactPolicy: resultContract.artifactPolicy,
          enabled: true,
          reviewState: 'approved' as const,
          riskLevel: capability === 'read' ? 'read_only' as const : 'non_destructive_write' as const,
          // Target run policy can auto-run only administrator-reviewed,
          // non-destructive writes. AgentV additionally enforces its exact
          // root-owned service allowlist on every restart.
          autoAllowed: capability === 'write'
        };
      });

    const servers = await listTargetMcpServers(workspaceId, targetId, targetType);
    const builtinServers = servers.filter((server) => server.provenance_type === 'builtin');
    if (builtinServers.length > 1) {
      incrementDuplicateBuiltInServerAnomaly(targetType);
      throw new Error('MCP_DUPLICATE_BUILTIN_SERVER_ANOMALY');
    }
    const existing = builtinServers[0];

    const existingTools = await listTargetMcpTools(
      workspaceId,
      targetId,
      targetType,
      { includeServerDisabled: true, includeDisabled: true }
    );
    const existingBuiltinNames = new Set(existingTools.filter((tool) => tool.source === 'builtin').map((tool) => tool.name));
    const discoveredNames = new Set(builtinTools.map((tool) => tool.name));
    const removeTools = [...existingBuiltinNames].filter((name) => !discoveredNames.has(name));

    if (!existing) {
      const created = await syncBuiltInMcpServer({
        workspaceId,
        destination: { kind: 'target', id: targetId, targetType },
        name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
        enabled: true,
        tools: builtinTools
      });
      webhooks.emit({
        type: 'tool.catalog.changed.v1',
        workspaceId,
        ...targetWebhookScope(targetId, targetType),
        subject: { type: targetType === KUBERNETES_TARGET_TYPE ? 'cluster' : 'target', id: targetId },
        data: {
          reason: 'builtin_tool_sync',
          serverName: created.server_name,
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

    const effectiveTools = builtinTools.map((tool) => {
      const current = existingTools.find((candidate) => (
        candidate.server_id === existing.id && candidate.name === tool.name && candidate.source === 'builtin'
      ));
      return current ? { ...tool, enabled: current.enabled } : tool;
    });
    const updated = await syncBuiltInMcpServer({
      workspaceId,
      destination: { kind: 'target', id: targetId, targetType },
      serverId: existing.id,
      name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
      enabled: existing.enabled,
      tools: effectiveTools
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
          serverName: existing.server_name,
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
    if (isMcpLifecycleFencedError(err)) {
      logger.info({ workspaceId, targetId, targetType }, 'Skipped built-in target tool sync for lifecycle-fenced destination');
      return {
        ok: false,
        workspaceId,
        targetId,
        targetType,
        discoveredToolCount: 0,
        registeredToolCount: 0,
        addedTools: [],
        removedTools: [],
        terminal: true,
        error: 'MCP_LIFECYCLE_FENCED'
      };
    }
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
