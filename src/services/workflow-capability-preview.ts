import type { AgentDefinition } from '../types/agents.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowCapabilityAttachmentPreview,
  WorkflowCapabilityToolPreview
} from '../types/workflows.js';

export function directWorkflowAttachments(input: {
  agent: AgentDefinition;
  scope: CompiledWorkflowAccessScope;
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
