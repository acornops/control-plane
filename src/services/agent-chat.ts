import type { WorkspaceCapability } from '../auth/authorization.js';
import type { AgentDefinition } from '../types/agents.js';
import type { CompiledAgentChatAccessScope } from '../types/agent-chat.js';
import type { CapabilityAccessActor } from '../types/capability-access.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { compileAgentCapabilityProjection } from './agent-capability-access.js';
import { CapabilityAccessDeniedError } from './capability-access-errors.js';
import { resolveCapabilityRoutingMappings } from './capability-routing-resolution.js';

export function defaultAgentConversationAccessMode(
  permissionMode: AgentDefinition['permissionMode'],
  canCreateReadOnlyRuns: boolean,
  canCreateWriteRuns: boolean
): 'read_only' | 'read_write' | null {
  if (permissionMode !== 'read_only' && canCreateWriteRuns) return 'read_write';
  if (canCreateReadOnlyRuns) return 'read_only';
  return null;
}

export function agentConversationPolicyAllowsAccess(
  permissionMode: AgentDefinition['permissionMode'],
  accessMode: 'read_only' | 'read_write'
): boolean {
  return accessMode === 'read_only' || permissionMode !== 'read_only';
}

export async function compileAgentConversationRunScope(input: {
  agent: AgentDefinition;
  actor: CapabilityAccessActor;
  accessMode: 'read_only' | 'read_write';
}): Promise<CompiledAgentChatAccessScope> {
  const requiredCapability: WorkspaceCapability = input.accessMode === 'read_write'
    ? 'create_read_write_runs'
    : 'create_read_only_runs';
  if (!input.actor.permissions[requiredCapability]) {
    throw new CapabilityAccessDeniedError(
      'CAPABILITY_PERMISSION_DENIED',
      'Current workspace role cannot create this Agent run.',
      { missingPermissions: [requiredCapability] }
    );
  }
  if (input.agent.status !== 'active' || input.agent.reviewState !== 'reviewed') {
    throw new CapabilityAccessDeniedError(
      'CAPABILITY_MAPPING_UNAVAILABLE',
      'Agent must be active and reviewed before it can run.'
    );
  }
  const mappings = resolveCapabilityRoutingMappings([input.agent], await listCapabilityRoutingMappings(input.agent.workspaceId, {
    activeReviewedOnly: true,
    capabilityIds: input.agent.semanticCapabilityIds
  }));
  const mappedCapabilityIds = new Set(mappings
    .filter((mapping) => mapping.agentId === input.agent.id)
    .map((mapping) => mapping.capabilityId));
  const availableCapabilityIds = input.agent.semanticCapabilityIds.filter((capabilityId) => (
    mappedCapabilityIds.has(capabilityId)
  ));
  const projection = compileAgentCapabilityProjection({
    agent: input.agent,
    mappings,
    mode: input.accessMode,
    restrictionMode: 'inherit',
    effectiveCapabilityIds: availableCapabilityIds,
    approvalGates: input.accessMode === 'read_write'
      && input.agent.permissionMode !== 'auto_allowed_changes'
      ? ['tool_write']
      : []
  });
  return {
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
    actor: { userId: input.actor.userId, role: input.actor.role },
    requiredPermissions: [requiredCapability],
    grantedCapabilities: [requiredCapability],
    principal: { type: 'user', id: input.actor.userId },
    ...projection
  };
}

export const MAX_AGENT_CONVERSATION_MESSAGE_LENGTH = 32_768;

export function compileAgentConversationMessage(content: string) {
  return {
    content: content.normalize('NFC')
  };
}
