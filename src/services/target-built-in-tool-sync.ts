import { agentGateway } from '../agent/ws-server.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementDuplicateBuiltInServerAnomaly } from '../metrics.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import {
  createTargetMcpServer,
  listTargetMcpServers,
  listTargetMcpTools,
  updateTargetMcpServer
} from './mcp-registry-client.js';
import { isReservedInternalToolName } from './internal-tool-names.js';
import { targetWebhookScope } from './target-webhook-scope.js';
import { sanitizeToolInputSchema } from './tool-metadata.js';
import { webhooks } from './webhooks.js';
import { repo } from '../store/repository.js';
import { reconcileTargetDiagnosticsForTarget } from './target-diagnostics-capability.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import { listAgentDefinitions } from '../store/repository-agents.js';
import { listWorkflowDefinitions } from '../store/repository-workflows.js';

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

async function reconcileCapabilityState(
  workspaceId: string,
  targetId: string,
  tools: Awaited<ReturnType<typeof listTargetMcpTools>>
): Promise<void> {
  try {
    const target = await repo.getTarget(workspaceId, targetId);
    if (!target) return;
    await reconcileTargetDiagnosticsForTarget(target, tools);
    const agents = await listAgentDefinitions(workspaceId, { includeInactive: true });
    await Promise.all(agents.map((agent) => refreshAgentReadiness(workspaceId, agent.id)));
    await Promise.all((await listWorkflowDefinitions(workspaceId)).map((workflow) => refreshWorkflowReadiness(workflow)));
  } catch (error) {
    logger.warn({ workspaceId, targetId, error }, 'Built-in tools synchronized but target diagnostics mapping reconciliation failed');
  }
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
        return {
          name: tool.name,
          timeoutMs: tool.timeout_ms || config.ASSISTANT_TOOL_DEFAULT_TIMEOUT_MS,
          description: tool.description,
          capability: normalizeCapability(tool.capability),
          version: typeof tool.version === 'string' && tool.version.length > 0 ? tool.version : 'v1',
          source: 'builtin' as const,
          inputSchema: sanitizeToolInputSchema(tool.inputSchema),
          outputSchema: resultContract.outputSchema,
          artifactPolicy: resultContract.artifactPolicy,
          enabled: true
        };
      });

    const servers = await listTargetMcpServers(workspaceId, targetId, targetType);
    const builtinServers = servers.filter((server) => server.provenance_type === 'builtin');
    if (builtinServers.length > 1) {
      incrementDuplicateBuiltInServerAnomaly(targetType);
      throw new Error('MCP_DUPLICATE_BUILTIN_SERVER_ANOMALY');
    }
    const existing = builtinServers[0];

    const existingTools = await listTargetMcpTools(workspaceId, targetId, targetType);
    const existingBuiltinNames = new Set(existingTools.filter((tool) => tool.source === 'builtin').map((tool) => tool.name));
    const discoveredNames = new Set(builtinTools.map((tool) => tool.name));
    const removeTools = [...existingBuiltinNames].filter((name) => !discoveredNames.has(name));

    if (!existing) {
      const created = await createTargetMcpServer({
        workspaceId,
        targetId,
        targetType,
        name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
        url: config.BUILTIN_TARGET_MCP_SERVER_URL,
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
      await reconcileCapabilityState(workspaceId, targetId, created.tools);
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
      name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
      url: config.BUILTIN_TARGET_MCP_SERVER_URL,
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
    await reconcileCapabilityState(workspaceId, targetId, updated.tools);
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
