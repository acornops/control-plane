import type { WorkspacePermissions } from '../auth/authorization.js';
import {
  ensureAgentChatCarrier
} from '../store/repository-workflows.js';
import type { AgentDefinition } from '../types/agents.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import { compileWorkflowScope } from './workflow-scope-compiler.js';

function carrierForMode(
  carrier: WorkflowDefinitionForAccess,
  mode: 'read_only' | 'read_write',
  agent: AgentDefinition
): WorkflowDefinitionForAccess {
  return {
    ...carrier,
    origin: {
      type: 'agent_chat',
      agentId: agent.id,
      agentVersion: agent.version,
      systemManaged: true
    },
    status: 'draft',
    capabilityPolicy: {
      ...carrier.capabilityPolicy,
      mode,
      approvalRequirements: mode === 'read_write' && agent.permissionMode !== 'auto_allowed_changes'
        ? ['tool_write']
        : []
    }
  };
}

function writeCeilingActor(actor: WorkflowAccessActor): WorkflowAccessActor {
  return {
    ...actor,
    permissions: {
      ...actor.permissions,
      create_sessions: true,
      create_read_only_runs: true,
      create_read_write_runs: true
    } as WorkspacePermissions
  };
}

export async function prepareAgentConversation(input: {
  agent: AgentDefinition;
  actor: WorkflowAccessActor;
}): Promise<{
  workflow: WorkflowDefinitionForAccess;
  readScope: CompiledWorkflowAccessScope;
  capabilityCeiling: CompiledWorkflowAccessScope;
}> {
  const carrier = await ensureAgentChatCarrier(input.agent, input.actor.userId);
  const readWorkflow = carrierForMode(carrier, 'read_only', input.agent);
  const writeWorkflow = carrierForMode(carrier, 'read_write', input.agent);
  const [readCompiled, writeCompiled] = await Promise.all([
    compileWorkflowScope({
      workflow: readWorkflow,
      actor: input.actor,
      approvedContextGrants: input.agent.contextGrants,
      resolutionPhase: 'session_ceiling'
    }),
    compileWorkflowScope({
      workflow: writeWorkflow,
      actor: writeCeilingActor(input.actor),
      approvedContextGrants: input.agent.contextGrants,
      resolutionPhase: 'session_ceiling'
    })
  ]);
  return {
    workflow: readWorkflow,
    readScope: readCompiled.scope,
    capabilityCeiling: writeCompiled.scope
  };
}

export function projectAgentConversationRunScope(
  scope: CompiledWorkflowAccessScope,
  resolution: Pick<CompiledWorkflowAccessScope, 'resourceBindings' | 'promptDigest' | 'bindingDigest'>
): Awaited<ReturnType<typeof compileWorkflowScope>> {
  const runScope: CompiledWorkflowAccessScope = {
    ...scope,
    promptDigest: resolution.promptDigest,
    bindingDigest: resolution.bindingDigest,
    resourceBindings: resolution.resourceBindings,
    resourceResolutionPhase: 'run_exact',
    jwtClaims: {
      ...scope.jwtClaims,
      permissions: {
        ...scope.jwtClaims.permissions,
        resource_bindings: [],
        binding_digest: resolution.bindingDigest
      }
    }
  };
  return {
    scope: runScope,
    selectedAgents: scope.selectedAgentSnapshots,
    specialistAgent: scope.selectedAgentSnapshots[0],
    mappings: scope.routingMappingSnapshots
  };
}

function refs(values: Array<{ serverId: string; toolName: string }>): Set<string> {
  return new Set(values.map((value) => `${value.serverId}\u0000${value.toolName}`));
}

export function pinnedAgentCapabilityRevocation(
  scope: CompiledWorkflowAccessScope,
  currentAgent: AgentDefinition | null
): string[] {
  const pinned = scope.selectedAgentSnapshots[0];
  if (!pinned || !currentAgent || currentAgent.status !== 'active') {
    return ['Agent is no longer available for execution.'];
  }
  const reasons: string[] = [];
  const currentMcpServers = new Set(currentAgent.mcpServers);
  for (const server of pinned.mcpServers) {
    if (!currentMcpServers.has(server)) reasons.push(`MCP server ${server} was revoked.`);
  }
  const currentMcpTools = refs(currentAgent.mcpTools);
  for (const tool of pinned.mcpTools) {
    if (!currentMcpTools.has(`${tool.serverId}\u0000${tool.toolName}`)) {
      reasons.push(`MCP tool ${tool.serverId}/${tool.toolName} was revoked.`);
    }
  }
  const currentTools = new Set(currentAgent.tools);
  for (const tool of pinned.tools) {
    if (!currentTools.has(tool)) reasons.push(`Tool ${tool} was revoked.`);
  }
  const currentSkills = new Set(currentAgent.skills);
  for (const skill of pinned.skills) {
    if (!currentSkills.has(skill)) reasons.push(`Skill ${skill} was revoked.`);
  }
  const currentContextGrants = new Set(currentAgent.contextGrants);
  for (const grant of pinned.contextGrants) {
    if (!currentContextGrants.has(grant)) reasons.push(`Context grant ${grant} was revoked.`);
  }
  const currentSemanticCapabilities = new Set(currentAgent.semanticCapabilityIds);
  for (const capability of pinned.semanticCapabilityIds) {
    if (!currentSemanticCapabilities.has(capability)) {
      reasons.push(`Semantic capability ${capability} was revoked.`);
    }
  }
  return reasons;
}
