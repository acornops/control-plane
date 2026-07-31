import type { AgentDefinition } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { TargetSummary } from '../types/domain.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCapabilityAttachmentPreview,
  WorkflowCapabilityToolPreview
} from '../types/workflows.js';
import {
  intersectGrantedTargetRunTools,
  type TargetRunToolResolution
} from './target-run-tool-resolution.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mappingTargetAliases(
  mappings: CapabilityRoutingMapping[],
  scope: CompiledWorkflowAccessScope
): Set<string> {
  const scopeRefs = new Set(scope.targetToolRefs.map((ref) => `${ref.serverId}\0${ref.toolName}`));
  return new Set(mappings.flatMap((mapping) => mapping.targetToolRefs)
    .filter((ref) => scopeRefs.has(`${ref.serverId}\0${ref.toolName}`))
    .map((ref) => ref.alias));
}

export function narrowWorkflowScopeToTargetTools(input: {
  scope: CompiledWorkflowAccessScope;
  mappings: CapabilityRoutingMapping[];
  resolution: TargetRunToolResolution;
}): { scope: CompiledWorkflowAccessScope; targetTools: ReturnType<typeof intersectGrantedTargetRunTools> } {
  const targetTools = intersectGrantedTargetRunTools(
    input.resolution,
    input.scope.tools,
    input.scope.targetToolRefs
  );
  const targetAliases = mappingTargetAliases(input.mappings, input.scope);
  const directTools = input.scope.tools.filter((tool) => !targetAliases.has(tool));
  const tools = uniqueSorted([...directTools, ...targetTools.allowedToolNames]);
  const toolOperations = Object.fromEntries(tools.map((tool) => [
    tool,
    targetTools.allowedToolOperations[tool] || input.scope.toolOperations[tool] || 'read'
  ]));
  const scope: CompiledWorkflowAccessScope = {
    ...input.scope,
    targetToolRefs: targetTools.allowedToolRefs,
    targetToolRoutes: (input.scope.targetToolRoutes || []).filter((route) => (
      targetTools.allowedToolRefs.some((ref) => ref.serverId === route.serverId && ref.toolName === route.toolName)
    )),
    tools,
    toolOperations,
    jwtClaims: {
      ...input.scope.jwtClaims,
      permissions: {
        ...input.scope.jwtClaims.permissions,
        allowed_tools: tools,
        allowed_tool_refs: [...input.scope.mcpTools, ...targetTools.allowedToolRefs].map((ref) => ({
          server_id: ref.serverId,
          tool_name: ref.toolName
        })),
        allowed_tool_operations: toolOperations,
        allowed_target_tool_routes: input.scope.targetToolRoutes.filter((route) => (
          targetTools.allowedToolRefs.some((ref) => ref.serverId === route.serverId && ref.toolName === route.toolName)
        )).map((route) => ({
          alias: route.alias,
          server_id: route.serverId,
          tool_name: route.toolName,
          operation: route.operation,
          target_id: route.targetId,
          target_type: route.targetType
        }))
      }
    }
  };
  return { scope, targetTools };
}

export function directWorkflowAttachments(input: {
  agent: AgentDefinition;
  scope: CompiledWorkflowAccessScope;
  target?: TargetSummary;
  excludedToolNames?: Iterable<string>;
}): {
  tools: WorkflowCapabilityToolPreview[];
  mcpServers: WorkflowCapabilityAttachmentPreview[];
  skills: WorkflowCapabilityAttachmentPreview[];
} {
  const mcpRefs = new Set(input.scope.mcpTools.map((ref) => `${ref.serverId}\0${ref.toolName}`));
  const installations = input.agent.mcpInstallations.filter((installation) => (
    installation.enabled && input.scope.mcpServers.includes(installation.id)
  ));
  const mcpTools = installations.flatMap((installation) => installation.tools
    .filter((tool) => tool.enabled && tool.reviewState === 'approved')
    .filter((tool) => mcpRefs.has(`${tool.serverId}\0${tool.toolName}`))
    .filter((tool) => !input.target || (
      (!installation.targetConstraints.targetIds.length || installation.targetConstraints.targetIds.includes(input.target.id))
      && (!installation.targetConstraints.targetTypes.length || installation.targetConstraints.targetTypes.includes(input.target.targetType))
    ))
    .map((tool): WorkflowCapabilityToolPreview => ({
      id: tool.alias,
      name: tool.alias,
      label: tool.toolName,
      description: tool.description,
      access: tool.capability,
      source: 'mcp',
      serverId: tool.serverId
    })));
  const mcpAliases = new Set(mcpTools.map((tool) => tool.name));
  const excludedToolNames = new Set(input.excludedToolNames || []);
  const nativeTools = input.scope.tools
    .filter((tool) => !mcpAliases.has(tool) && !excludedToolNames.has(tool) && !tool.startsWith('_acornops_'))
    .map((tool): WorkflowCapabilityToolPreview => ({
      id: tool,
      name: tool,
      label: tool,
      access: input.scope.toolOperations[tool] === 'write' ? 'write' : 'read',
      source: 'builtin'
    }));
  const skillNames = new Map(input.agent.skillInstallations.map((skill) => [skill.id, skill.name]));
  return {
    tools: [...mcpTools, ...nativeTools],
    mcpServers: installations.map((installation) => ({ id: installation.id, name: installation.name })),
    skills: input.scope.enabledSkills.map((id) => ({ id, name: skillNames.get(id) || id }))
  };
}

export function targetPreviewTools(
  tools: ReturnType<typeof intersectGrantedTargetRunTools>
): WorkflowCapabilityToolPreview[] {
  const serverIds = new Map(tools.allowedToolSpecs
    .filter((tool) => tool.server_id)
    .map((tool) => [tool.name, tool.server_id!]));
  return tools.previewItems.map((tool) => ({
    id: tool.id,
    name: tool.name,
    label: tool.label || tool.name,
    description: tool.description,
    access: tool.capability,
    source: 'target',
    ...(serverIds.get(tool.name) ? { serverId: serverIds.get(tool.name) } : {})
  }));
}
