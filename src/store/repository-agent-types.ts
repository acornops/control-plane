import type { AgentDefinition, AgentTriggerDefinition, AgentTriggerType } from '../types/agents.js';

export interface CreateAgentDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  instructions: string;
  ownerUserId: string;
  createdBy: string;
  origin?: AgentDefinition['origin'];
  kind?: AgentDefinition['kind'];
  systemRole?: AgentDefinition['systemRole'];
  reviewState?: AgentDefinition['reviewState'];
  providerType?: AgentDefinition['providerType'];
  mcpServers?: string[];
  mcpTools?: AgentDefinition['mcpTools'];
  mcpInstallations?: AgentDefinition['mcpInstallations'];
  tools?: string[];
  skills?: string[];
  skillInstallations?: AgentDefinition['skillInstallations'];
  contextGrants?: string[];
  approvalPolicy?: AgentDefinition['approvalPolicy'];
  trustPolicy?: AgentDefinition['trustPolicy'];
  targetScope?: AgentDefinition['targetScope'];
  permissionMode?: AgentDefinition['permissionMode'];
  semanticCapabilityIds?: string[];
  delegateAgentIds?: string[];
}

export interface AgentDefinitionUpdate {
  name?: string;
  description?: string;
  instructions?: string;
  status?: AgentDefinition['status'];
  kind?: AgentDefinition['kind'];
  reviewState?: AgentDefinition['reviewState'];
  providerType?: AgentDefinition['providerType'];
  ownerUserId?: string;
  mcpServers?: string[];
  mcpTools?: AgentDefinition['mcpTools'];
  mcpInstallations?: AgentDefinition['mcpInstallations'];
  tools?: string[];
  skills?: string[];
  skillInstallations?: AgentDefinition['skillInstallations'];
  contextGrants?: string[];
  approvalPolicy?: AgentDefinition['approvalPolicy'];
  trustPolicy?: AgentDefinition['trustPolicy'];
  targetScope?: AgentDefinition['targetScope'];
  permissionMode?: AgentDefinition['permissionMode'];
  semanticCapabilityIds?: string[];
  delegateAgentIds?: string[];
}

export interface CreateAgentTriggerInput {
  type: AgentTriggerType;
  enabled?: boolean;
  name?: string;
  schedule?: AgentTriggerDefinition['schedule'];
  eventFilter?: Record<string, unknown>;
  principal?: AgentTriggerDefinition['principal'];
  secretCiphertext?: string;
}
