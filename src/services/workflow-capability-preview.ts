import type { AgentDefinition } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { TargetAgentRegistration, TargetSummary } from '../types/domain.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCapabilityAttachmentPreview,
  WorkflowCapabilityPreviewReasonCode,
  WorkflowCapabilityToolPreview,
  WorkflowDefinitionForAccess,
  WorkflowTargetCapabilityCandidate
} from '../types/workflows.js';
import {
  capabilityRequiresExactTarget,
  targetAllowedByAgentScope,
  targetAllowedByMapping,
  targetAllowedByWorkflowConstraints
} from './target-scope-authorization.js';
import { workflowTargetPolicy } from './prompt-resources/providers/target-provider.js';
import {
  intersectGrantedTargetRunTools,
  type TargetRunToolResolution
} from './target-run-tool-resolution.js';

const CANDIDATE_REASONS: Record<WorkflowCapabilityPreviewReasonCode, string> = {
  TARGET_REQUIRED: 'Select one exact target to resolve target tools.',
  TARGET_NOT_FOUND: 'The selected target is unavailable in this workspace.',
  TARGET_TYPE_MISMATCH: 'The requested target type does not match the stored target type.',
  TARGET_OFFLINE: 'This target is offline.',
  TARGET_STATUS_UNKNOWN: 'This target connection status is unknown.',
  TARGET_WRITE_UNSUPPORTED: 'This target currently advertises diagnostics only; remediation requires write capability.',
  CAPABILITY_MAPPING_UNAVAILABLE: 'An active reviewed capability mapping is unavailable for this target.',
  TARGET_TOOL_MAPPING_UNAVAILABLE: 'The required target tool mapping is unavailable for this target.',
  TARGET_TOOL_CATALOG_UNAVAILABLE: 'The target tool catalog is currently unavailable.',
  MCP_CONNECTION_UNAVAILABLE: 'A directly attached MCP capability is currently unavailable.'
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function currentWorkflowMappings(
  workflow: WorkflowDefinitionForAccess,
  agents: AgentDefinition[],
  mappings: CapabilityRoutingMapping[]
): CapabilityRoutingMapping[] {
  const agentVersions = new Map(agents.map((agent) => [agent.id, agent.version]));
  return mappings.filter((mapping) => (
    workflow.agentIds.includes(mapping.agentId)
    && agentVersions.get(mapping.agentId) === mapping.agentVersion
    && mapping.status === 'active'
    && mapping.reviewState === 'reviewed'
  ));
}

export function workflowRequiresExactTarget(semanticCapabilityIds: string[]): boolean {
  return semanticCapabilityIds.some(capabilityRequiresExactTarget);
}

export function workflowTargetCandidates(input: {
  workflow: WorkflowDefinitionForAccess;
  agents: AgentDefinition[];
  semanticCapabilityIds: string[];
  mappings: CapabilityRoutingMapping[];
  targets: TargetSummary[];
  registrations: TargetAgentRegistration[];
}): WorkflowTargetCapabilityCandidate[] {
  const registrations = new Map(input.registrations.map((registration) => [registration.targetId, registration]));
  const mappings = currentWorkflowMappings(input.workflow, input.agents, input.mappings);
  const targetCapabilityIds = input.semanticCapabilityIds.filter(capabilityRequiresExactTarget);
  const requiresWrite = input.workflow.capabilityPolicy.mode === 'read_write'
    && targetCapabilityIds.includes('target.remediation.write');
  return input.targets
    .filter((target) => targetAllowedByWorkflowConstraints(workflowTargetPolicy(input.workflow), target))
    .filter((target) => input.agents.some((agent) => targetAllowedByAgentScope(agent.targetScope, target)))
    .map((target): WorkflowTargetCapabilityCandidate => {
      let reasonCode: WorkflowCapabilityPreviewReasonCode | undefined;
      if (target.status === 'offline') reasonCode = 'TARGET_OFFLINE';
      else if (target.status === 'unknown') reasonCode = 'TARGET_STATUS_UNKNOWN';
      else if (requiresWrite && !registrations.get(target.id)?.capabilities?.includes('write')) {
        reasonCode = 'TARGET_WRITE_UNSUPPORTED';
      } else {
        for (const capabilityId of targetCapabilityIds) {
          const compatible = mappings.filter((mapping) => (
            mapping.capabilityId === capabilityId
            && targetAllowedByMapping(mapping, target)
            && input.agents.some((agent) => agent.id === mapping.agentId && targetAllowedByAgentScope(agent.targetScope, target))
          ));
          if (!compatible.length) {
            reasonCode = 'CAPABILITY_MAPPING_UNAVAILABLE';
            break;
          }
          if (!compatible.some((mapping) => mapping.targetToolRefs.length > 0)) {
            reasonCode = 'TARGET_TOOL_MAPPING_UNAVAILABLE';
            break;
          }
        }
      }
      const status = reasonCode === 'TARGET_OFFLINE' || reasonCode === 'TARGET_STATUS_UNKNOWN'
        ? 'unavailable' as const
        : reasonCode
          ? 'unsupported' as const
          : 'ready' as const;
      return {
        id: target.id,
        name: target.name,
        targetType: target.targetType,
        status,
        ...(reasonCode ? { reasonCode, reason: CANDIDATE_REASONS[reasonCode] } : {})
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function unavailableSelectedTarget(
  target: { id: string; targetType: TargetSummary['targetType']; name?: string },
  reasonCode: 'TARGET_NOT_FOUND' | 'TARGET_TYPE_MISMATCH'
): WorkflowTargetCapabilityCandidate {
  return {
    id: target.id,
    name: target.name || target.id,
    targetType: target.targetType,
    status: 'unavailable',
    reasonCode,
    reason: CANDIDATE_REASONS[reasonCode]
  };
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
        allowed_tool_operations: toolOperations
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
