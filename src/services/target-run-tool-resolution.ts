import { config } from '../config.js';
import { logger } from '../logger.js';
import { listTargetMcpTools, McpToolConfig } from './mcp-registry-client.js';
import { syncTargetBuiltInTools } from './target-built-in-tool-sync.js';
import { isReservedInternalToolName } from './internal-tool-names.js';
import { sanitizeToolInputSchema, sanitizeToolText } from './tool-metadata.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, TargetType, ToolAccessMode } from '../types/domain.js';
import { listWorkspaceNativeToolsForInvocationScope } from './workspace-native-tools.js';

export const WEB_SEARCH_TOOL_ID = 'web_search';
export const TARGET_INSIGHTS_TOOL_ID = 'target_insights';

function defaultWebSearchConfig(): Record<string, unknown> {
  return {
    domainFilters: {
      allowedDomains: [],
      blockedDomains: []
    }
  };
}

function webSearchConfig(config?: Record<string, unknown>): Record<string, unknown> {
  return config || defaultWebSearchConfig();
}

export type ToolCapability = 'read' | 'write';
export type ToolRuntimeKind = 'function' | 'provider_native';
export type ToolPreviewSource = 'builtin' | 'mcp' | 'provider_native';
export type WriteUnavailableReason = 'run_read_only' | 'agent_write_disabled' | null;

export interface TargetRunToolSpec {
  name: string;
  server_id?: string;
  tool_name?: string;
  description: string;
  input_schema: Record<string, unknown>;
  capability: ToolCapability;
}

export interface TargetRunNativeTool {
  id: string;
  config: Record<string, unknown>;
}

export interface TargetRunPlatformFunction {
  id: string;
  modelAlias: string;
}

export interface TargetRunToolPreviewItem {
  id: string;
  name: string;
  label?: string;
  description: string;
  capability: ToolCapability;
  runtimeKind: ToolRuntimeKind;
  source: ToolPreviewSource;
}

export interface TargetRunToolPreviewSummary {
  totalAllowed: number;
  functionAllowed: number;
  nativeAllowed: number;
  readAllowed: number;
  writeAllowed: number;
  configuredWrite: number;
  excludedWrite: number;
}

export interface TargetRunToolResolution {
  targetSupportsWrite: boolean;
  allowedToolNames: string[];
  allowedToolSpecs: TargetRunToolSpec[];
  allowedToolOperations: Record<string, ToolCapability>;
  allowedToolRefs: Array<{ serverId: string; toolName: string }>;
  allowedNativeTools: TargetRunNativeTool[];
  platformFunctions: TargetRunPlatformFunction[];
  previewItems: TargetRunToolPreviewItem[];
  summary: TargetRunToolPreviewSummary;
  writeUnavailableReason: WriteUnavailableReason;
  confirmationRequiredForWrite: boolean;
  approvalTimeoutSeconds: number;
}

export function normalizeToolCapability(tool: Pick<McpToolConfig, 'capability'>): ToolCapability {
  return tool.capability === 'read' ? 'read' : 'write';
}

async function resolveGatewayTargetToolsForRun(
  workspaceId: string,
  targetId: string,
  targetType: TargetType,
  runId?: string,
  resyncIfEmpty = true
): Promise<McpToolConfig[]> {
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    if (!resyncIfEmpty) throw err;
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools; attempting resync');
  }

  if (!resyncIfEmpty) return [];

  const syncResult = await syncTargetBuiltInTools(workspaceId, targetId, targetType);
  if (!syncResult.ok || syncResult.registeredToolCount === 0) {
    logger.warn(
      {
        workspaceId,
        targetId,
        targetType,
        runId,
        ok: syncResult.ok,
        discoveredToolCount: syncResult.discoveredToolCount,
        registeredToolCount: syncResult.registeredToolCount,
        error: syncResult.error
      },
      'Run bootstrap built-in tool sync did not register target tools'
    );
  }
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools after resync');
  }

  logger.warn(
    { workspaceId, targetId, targetType, runId },
    'No gateway-registered target tools available for run bootstrap'
  );
  return [];
}

async function resolveWriteConfirmationRequired(targetType: TargetType, targetId: string): Promise<boolean> {
  if (targetType === KUBERNETES_TARGET_TYPE) {
    return (await repo.getCluster(targetId))?.writeConfirmationPolicy.effectiveRequired ?? config.ASSISTANT_WRITE_CONFIRMATION_REQUIRED;
  }
  return config.ASSISTANT_WRITE_CONFIRMATION_REQUIRED;
}

function nativeToolDescription(toolId: string): string {
  if (toolId === WEB_SEARCH_TOOL_ID) {
    return 'Allow assistant runs for this target to search the web through the selected LLM provider.';
  }
  return `Allow assistant runs for this target to use native tool "${toolId}".`;
}

function nativeToolLabel(toolId: string): string {
  if (toolId === WEB_SEARCH_TOOL_ID) {
    return 'Web Search';
  }
  return toolId;
}

function mcpToolDescription(tool: Pick<McpToolConfig, 'name' | 'description'>): string {
  return sanitizeToolText(tool.description) || `Execute tool "${tool.name}" for target diagnostics.`;
}

function runtimeToolName(tool: McpToolConfig): string {
  return tool.source === 'builtin' ? tool.name : tool.model_alias;
}

export async function resolveTargetRunTools(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  toolAccessMode: ToolAccessMode;
  runId?: string;
  includeNativeTools?: boolean;
  strictMcpResolution?: boolean;
  resyncIfEmpty?: boolean;
}): Promise<TargetRunToolResolution> {
  const { workspaceId, targetId, targetType, toolAccessMode, runId } = params;
  const agentRegistration = await repo.getTargetAgentRegistration(targetId);
  const targetSupportsWrite = Boolean(agentRegistration?.capabilities?.includes('write'));
  const runAllowsWrite = toolAccessMode === 'read_write';
  let configuredWrite = 0;
  let excludedWrite = 0;
  let allowedToolNames: string[] = [];
  let allowedToolSpecs: TargetRunToolSpec[] = [];
  let allowedToolRefs: Array<{ serverId: string; toolName: string }> = [];
  let functionPreviewItems: TargetRunToolPreviewItem[] = [];

  try {
    const [tools, overrides] = await Promise.all([
      resolveGatewayTargetToolsForRun(workspaceId, targetId, targetType, runId, params.resyncIfEmpty !== false),
      repo.listTargetToolOverrides(targetId)
    ]);
    const enabledTools = tools
      .filter((tool) => {
        if (!isReservedInternalToolName(tool.name)) return true;
        logger.warn({ workspaceId, targetId, targetType, runId, toolName: tool.name }, 'Skipping reserved internal tool name in run tool resolution');
        return false;
      })
      .filter((tool) => {
        if (tool.server_id?.trim() && (tool.source === 'builtin' || tool.model_alias?.trim())) return true;
        logger.warn(
          { workspaceId, targetId, targetType, runId, toolName: tool.name },
          'Skipping target tool without a qualified server identity'
        );
        return false;
      })
      .filter((tool) => {
        const effectiveEnabled = tool.source === 'builtin' && Object.prototype.hasOwnProperty.call(overrides, tool.name)
          ? overrides[tool.name]
          : tool.enabled !== false;
        if (!effectiveEnabled) return false;
        const capability = normalizeToolCapability(tool);
        if (capability === 'write') {
          configuredWrite += 1;
        }
        if (capability === 'write' && !targetSupportsWrite) {
          excludedWrite += 1;
          return false;
        }
        if (capability === 'write' && !runAllowsWrite) {
          excludedWrite += 1;
          return false;
        }
        return true;
      })
      .sort((left, right) => runtimeToolName(left).localeCompare(runtimeToolName(right)));

    allowedToolNames = [...new Set(enabledTools.map(runtimeToolName))];
    allowedToolRefs = enabledTools.map((tool) => ({
      serverId: tool.server_id,
      toolName: tool.name
    }));
    allowedToolSpecs = enabledTools.map((tool) => ({
      name: runtimeToolName(tool),
      server_id: tool.server_id,
      tool_name: tool.name,
      description: mcpToolDescription(tool),
      capability: normalizeToolCapability(tool),
      input_schema: sanitizeToolInputSchema(tool.input_schema)
    }));
    const previewToolNames = new Set<string>();
    functionPreviewItems = enabledTools
      .filter((tool) => {
        const runtimeName = runtimeToolName(tool);
        if (previewToolNames.has(runtimeName)) return false;
        previewToolNames.add(runtimeName);
        return true;
      })
      .map((tool) => ({
        id: runtimeToolName(tool),
        name: runtimeToolName(tool),
        label: tool.name,
        description: mcpToolDescription(tool),
        capability: normalizeToolCapability(tool),
        runtimeKind: 'function',
        source: tool.source === 'builtin' ? 'builtin' : 'mcp'
      }));
  } catch (err) {
    if (params.strictMcpResolution) throw err;
    logger.warn(
      {
        runId,
        workspaceId,
        targetId,
        targetType,
        err
      },
      'Failed resolving run tool catalog; continuing with no tool permissions'
    );
  }

  let allowedNativeTools: TargetRunNativeTool[] = [];
  let targetInsightsPreviewItems: TargetRunToolPreviewItem[] = [];
  const targetChatPlatformNativeTools = params.includeNativeTools === false
    ? []
    : listWorkspaceNativeToolsForInvocationScope('target_chat');
  const disabledPlatformNativeToolIds = new Set<string>();
  if (params.includeNativeTools !== false) {
    try {
      const webSearchSetting = await repo.getTargetToolSetting(targetId, WEB_SEARCH_TOOL_ID);
      if (webSearchSetting?.enabled !== false) {
        allowedNativeTools = [{
          id: WEB_SEARCH_TOOL_ID,
          config: webSearchConfig(webSearchSetting?.config)
        }];
      }
      if (config.TARGET_INSIGHTS_ENABLED) {
        const targetInsightsSetting = await repo.getTargetToolSetting(targetId, TARGET_INSIGHTS_TOOL_ID);
        if (targetInsightsSetting?.enabled !== false) {
          targetInsightsPreviewItems = [{
            id: TARGET_INSIGHTS_TOOL_ID,
            name: TARGET_INSIGHTS_TOOL_ID,
            label: 'Insights',
            description: 'Retrieve target-specific troubleshooting insights.',
            capability: 'read',
            runtimeKind: 'function',
            source: 'builtin'
          }];
        }
      }
      const platformNativeSettings = await Promise.all(
        targetChatPlatformNativeTools
          .filter((tool) => tool.targetToggleable)
          .map(async (tool) => [tool.id, await repo.getTargetToolSetting(targetId, tool.id)] as const)
      );
      for (const [toolId, setting] of platformNativeSettings) {
        if (setting?.enabled === false) disabledPlatformNativeToolIds.add(toolId);
      }
    } catch (err) {
      logger.warn(
        {
          runId,
          workspaceId,
          targetId,
          targetType,
          err
        },
        'Failed resolving run native tools; continuing with no native tool permissions'
      );
    }
  }

  const platformNativeTools = targetChatPlatformNativeTools
    .filter((tool) => !disabledPlatformNativeToolIds.has(tool.id));
  for (const tool of platformNativeTools) {
    if (!allowedToolNames.includes(tool.modelAlias)) allowedToolNames.push(tool.modelAlias);
    if (!allowedToolSpecs.some((spec) => spec.name === tool.modelAlias)) {
      allowedToolSpecs.push({
        name: tool.modelAlias,
        description: tool.description,
        input_schema: tool.inputSchema,
        capability: tool.approvalOperation
      });
    }
    if (!functionPreviewItems.some((item) => item.name === tool.modelAlias)) {
      functionPreviewItems.push({
        id: tool.id,
        name: tool.modelAlias,
        label: tool.title,
        description: tool.description,
        capability: tool.approvalOperation,
        runtimeKind: 'function',
        source: 'builtin'
      });
    }
  }

  const nativePreviewItems: TargetRunToolPreviewItem[] = allowedNativeTools
    .filter((tool) => tool.id === WEB_SEARCH_TOOL_ID)
    .map((tool) => ({
    id: tool.id,
    name: tool.id,
    label: nativeToolLabel(tool.id),
    description: nativeToolDescription(tool.id),
    capability: 'read',
    runtimeKind: 'provider_native',
    source: 'provider_native'
    }));
  const previewItems = [...functionPreviewItems, ...nativePreviewItems, ...targetInsightsPreviewItems]
    .sort((left, right) => left.name.localeCompare(right.name) || left.runtimeKind.localeCompare(right.runtimeKind));
  const allowedToolOperations = Object.fromEntries(
    allowedToolSpecs.map((tool) => [tool.name, tool.capability])
  );
  const writeAllowed = previewItems.filter((tool) => tool.capability === 'write').length;
  const readAllowed = previewItems.filter((tool) => tool.capability === 'read').length;

  return {
    targetSupportsWrite,
    allowedToolNames,
    allowedToolSpecs,
    allowedToolOperations,
    allowedToolRefs,
    allowedNativeTools,
    platformFunctions: platformNativeTools.map((tool) => ({ id: tool.id, modelAlias: tool.modelAlias })),
    previewItems,
    summary: {
      totalAllowed: previewItems.length,
      functionAllowed: functionPreviewItems.length,
      nativeAllowed: nativePreviewItems.length,
      readAllowed,
      writeAllowed,
      configuredWrite,
      excludedWrite
    },
    writeUnavailableReason: excludedWrite > 0
      ? !runAllowsWrite
        ? 'run_read_only'
        : !targetSupportsWrite
          ? 'agent_write_disabled'
          : null
      : null,
    confirmationRequiredForWrite: runAllowsWrite
      ? await resolveWriteConfirmationRequired(targetType, targetId)
      : false,
    approvalTimeoutSeconds: config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS
  };
}

export function intersectGrantedTargetRunTools(
  resolution: TargetRunToolResolution,
  grantedToolNames: Iterable<string>,
  grantedToolRefs: Iterable<{ serverId: string; toolName: string }>
): Pick<
  TargetRunToolResolution,
  'allowedToolNames' | 'allowedToolSpecs' | 'allowedToolOperations' | 'allowedToolRefs' | 'previewItems'
> {
  const grantedNames = new Set(grantedToolNames);
  const grantedRefs = new Set(Array.from(grantedToolRefs, (ref) => `${ref.serverId}\0${ref.toolName}`));
  const allowedToolSpecs = resolution.allowedToolSpecs.filter((spec) => (
    grantedNames.has(spec.name)
    && Boolean(spec.server_id && spec.tool_name && grantedRefs.has(`${spec.server_id}\0${spec.tool_name}`))
  ));
  const allowedToolNames = allowedToolSpecs.map((spec) => spec.name);
  const allowedNameSet = new Set(allowedToolNames);
  return {
    allowedToolNames,
    allowedToolSpecs,
    allowedToolOperations: Object.fromEntries(allowedToolSpecs.map((spec) => [spec.name, spec.capability])),
    allowedToolRefs: resolution.allowedToolRefs.filter((ref) => allowedToolSpecs.some((spec) => (
      spec.server_id === ref.serverId && spec.tool_name === ref.toolName
    ))),
    previewItems: resolution.previewItems.filter((item) => allowedNameSet.has(item.name))
  };
}
