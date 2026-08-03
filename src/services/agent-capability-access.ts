import type { AgentDefinition } from '../types/agents.js';
import type { CompiledAgentChatAccessScope } from '../types/agent-chat.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type { CapabilityRestrictionMode } from '../types/capability-access.js';
import type { RunPermissionMode } from '../types/run-permission.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import { CapabilityAccessDeniedError } from './capability-access-errors.js';

type AgentCapabilityProjection = Omit<
  CompiledAgentChatAccessScope,
  'agentId' | 'workspaceId' | 'actor' | 'requiredPermissions' | 'grantedCapabilities' | 'principal'
>;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function toolOperationForMode(
  tool: string,
  mode: CompiledAgentChatAccessScope['mode']
): WorkspaceAuditOperation {
  if (mode === 'read_only') return 'read';
  const operation = tool.split('.').at(-1)?.toLowerCase() || '';
  return /^(read|list|get|search|query|summarize|describe|inspect|preview|status)$/.test(operation)
    ? 'read'
    : 'write';
}

function mappingsForAgent(input: {
  mappings: CapabilityRoutingMapping[];
  agent: AgentDefinition;
  capabilityIds: string[];
}): CapabilityRoutingMapping[] {
  return input.capabilityIds.flatMap((capabilityId) => {
    const mappings = input.mappings.filter((candidate) => (
      candidate.capabilityId === capabilityId
      && candidate.agentId === input.agent.id
      && candidate.status === 'active'
      && candidate.reviewState === 'reviewed'
    ));
    if (mappings.length === 0) {
      throw new CapabilityAccessDeniedError(
        'CAPABILITY_MAPPING_UNAVAILABLE',
        `No active reviewed mapping is available for ${capabilityId}.`
      );
    }
    return mappings;
  });
}

export function compileAgentCapabilityProjection(input: {
  agent: AgentDefinition;
  mappings: CapabilityRoutingMapping[];
  mode: CompiledAgentChatAccessScope['mode'];
  restrictionMode: CapabilityRestrictionMode;
  effectiveCapabilityIds: string[];
  approvalGates: string[];
  permissionMode?: RunPermissionMode;
  delegatedSpecialist?: boolean;
}): AgentCapabilityProjection {
  const mappings = mappingsForAgent({
    mappings: input.mappings,
    agent: input.agent,
    capabilityIds: input.effectiveCapabilityIds
  });
  const inheritAgentAttachments = input.restrictionMode === 'inherit';
  const mappingAttachments = mappings;
  const directMcpTools = inheritAgentAttachments
    ? input.agent.mcpInstallations.flatMap((installation) => {
        if (!installation.enabled) return [];
        return installation.tools
          .filter((tool) => tool.enabled && tool.reviewState === 'approved')
          .map((tool) => ({
            serverId: tool.serverId,
            toolName: tool.toolName,
            alias: tool.alias,
            operation: tool.capability
          }));
      })
    : [];
  const mcpTools = [...directMcpTools, ...mappingAttachments.flatMap((mapping) => mapping.mcpTools)]
    .filter((ref, index, refs) => refs.findIndex((candidate) => (
      candidate.serverId === ref.serverId && candidate.toolName === ref.toolName
    )) === index);
  const nativeToolIds = uniqueSorted([
    ...(inheritAgentAttachments ? input.agent.tools : []),
    ...mappingAttachments.flatMap((mapping) => mapping.nativeToolIds)
  ]);
  const tools = uniqueSorted([
    ...mcpTools.map((ref) => ref.alias),
    ...nativeToolIds
  ]);
  const toolOperations = {
    ...Object.fromEntries(mcpTools.map((ref) => [ref.alias, ref.operation])),
    ...Object.fromEntries(nativeToolIds.map((tool) => [
      tool,
      getWorkspaceNativeTool(tool)?.approvalOperation || toolOperationForMode(tool, input.mode)
    ]))
  } as Record<string, WorkspaceAuditOperation>;
  const effectiveTools = tools.filter((tool) => (
    input.mode === 'read_write' || toolOperations[tool] === 'read'
  ));
  const nativeToolConfigs = Object.fromEntries(nativeToolIds
    .filter((toolId) => effectiveTools.includes(toolId) && input.agent.nativeToolConfigs[toolId])
    .map((toolId) => [toolId, structuredClone(input.agent.nativeToolConfigs[toolId])]));
  const effectiveRefs = mcpTools.filter((ref) => input.mode === 'read_write' || ref.operation === 'read');
  return {
    mode: input.mode,
    semanticCapabilityIds: input.effectiveCapabilityIds,
    capabilityRestrictionMode: input.restrictionMode,
    mcpServers: uniqueSorted(effectiveRefs.map((ref) => ref.serverId)),
    mcpTools: effectiveRefs.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName })),
    tools: effectiveTools,
    toolOperations,
    nativeToolConfigs,
    enabledSkills: uniqueSorted([
      ...(inheritAgentAttachments
        ? input.agent.skillInstallations.filter((skill) => skill.enabled).map((skill) => skill.id)
        : []),
      ...mappingAttachments.flatMap((mapping) => mapping.skillIds)
    ]),
    approvalGates: uniqueSorted(input.approvalGates),
    permissionMode: input.permissionMode || (input.mode === 'read_only' || input.agent.permissionMode === 'read_only'
      ? 'read_only'
      : input.agent.permissionMode)
  };
}
