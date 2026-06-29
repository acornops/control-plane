import { config } from '../config.js';
import { logger } from '../logger.js';
import { listTargetMcpTools, McpToolConfig } from './mcp-registry-client.js';
import { syncTargetBuiltInTools } from './target-built-in-tool-sync.js';
import { isReservedInternalToolName } from './internal-tool-names.js';
import { sanitizeToolInputSchema, sanitizeToolText } from './tool-metadata.js';
import { repo } from '../store/repository.js';
import { KUBERNETES_TARGET_TYPE, TargetType, ToolAccessMode } from '../types/domain.js';

export const WEB_SEARCH_TOOL_ID = 'web_search';
export const KNOWLEDGE_BANK_TOOL_ID = 'knowledge_bank';

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
  description: string;
  input_schema: Record<string, unknown>;
  capability: ToolCapability;
}

export interface TargetRunNativeTool {
  id: string;
  config: Record<string, unknown>;
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
  allowedNativeTools: TargetRunNativeTool[];
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
  runId?: string
): Promise<McpToolConfig[]> {
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools; attempting resync');
  }

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
    return (await repo.getCluster(targetId))?.writeConfirmationPolicy.effectiveRequired ?? config.AGENT_WRITE_CONFIRMATION_REQUIRED;
  }
  return config.AGENT_WRITE_CONFIRMATION_REQUIRED;
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

export async function resolveTargetRunTools(params: {
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  toolAccessMode: ToolAccessMode;
  runId?: string;
}): Promise<TargetRunToolResolution> {
  const { workspaceId, targetId, targetType, toolAccessMode, runId } = params;
  const agentRegistration = await repo.getTargetAgentRegistration(targetId);
  const targetSupportsWrite = Boolean(agentRegistration?.capabilities?.includes('write'));
  const runAllowsWrite = toolAccessMode === 'read_write';
  let configuredWrite = 0;
  let excludedWrite = 0;
  let allowedToolNames: string[] = [];
  let allowedToolSpecs: TargetRunToolSpec[] = [];
  let functionPreviewItems: TargetRunToolPreviewItem[] = [];

  try {
    const [tools, overrides] = await Promise.all([
      resolveGatewayTargetToolsForRun(workspaceId, targetId, targetType, runId),
      repo.listTargetToolOverrides(targetId)
    ]);
    const enabledTools = tools
      .filter((tool) => {
        if (!isReservedInternalToolName(tool.name)) return true;
        logger.warn({ workspaceId, targetId, targetType, runId, toolName: tool.name }, 'Skipping reserved internal tool name in run tool resolution');
        return false;
      })
      .filter((tool) => {
        const effectiveEnabled = Object.prototype.hasOwnProperty.call(overrides, tool.name)
          ? overrides[tool.name]
          : tool.enabled;
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
      .sort((left, right) => left.name.localeCompare(right.name));

    allowedToolNames = [...new Set(enabledTools.map((tool) => tool.name))];
    allowedToolSpecs = enabledTools.map((tool) => ({
      name: tool.name,
      description: mcpToolDescription(tool),
      capability: normalizeToolCapability(tool),
      input_schema: sanitizeToolInputSchema(tool.input_schema)
    }));
    const previewToolNames = new Set<string>();
    functionPreviewItems = enabledTools
      .filter((tool) => {
        if (previewToolNames.has(tool.name)) return false;
        previewToolNames.add(tool.name);
        return true;
      })
      .map((tool) => ({
        id: tool.name,
        name: tool.name,
        description: mcpToolDescription(tool),
        capability: normalizeToolCapability(tool),
        runtimeKind: 'function',
        source: tool.source === 'builtin' ? 'builtin' : 'mcp'
      }));
  } catch (err) {
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
  let knowledgeBankPreviewItems: TargetRunToolPreviewItem[] = [];
  try {
    const webSearchSetting = await repo.getTargetToolSetting(targetId, WEB_SEARCH_TOOL_ID);
    if (webSearchSetting?.enabled ?? true) {
      allowedNativeTools = [{
        id: WEB_SEARCH_TOOL_ID,
        config: webSearchConfig(webSearchSetting?.config)
      }];
    }
    if (config.KNOWLEDGE_BANK_ENABLED) {
      const knowledgeBankSetting = await repo.getTargetToolSetting(targetId, KNOWLEDGE_BANK_TOOL_ID);
      if (knowledgeBankSetting?.enabled ?? true) {
        knowledgeBankPreviewItems = [{
          id: KNOWLEDGE_BANK_TOOL_ID,
          name: KNOWLEDGE_BANK_TOOL_ID,
          label: 'Knowledge Bank',
          description: 'Retrieve target-specific troubleshooting knowledge.',
          capability: 'read',
          runtimeKind: 'function',
          source: 'builtin'
        }];
      }
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

  const nativePreviewItems: TargetRunToolPreviewItem[] = allowedNativeTools.map((tool) => ({
    id: tool.id,
    name: tool.id,
    label: nativeToolLabel(tool.id),
    description: nativeToolDescription(tool.id),
    capability: 'read',
    runtimeKind: 'provider_native',
    source: 'provider_native'
  }));
  const previewItems = [...functionPreviewItems, ...nativePreviewItems, ...knowledgeBankPreviewItems]
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
    allowedNativeTools,
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
    approvalTimeoutSeconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS
  };
}
