import type { AgentDefinition } from '../types/agents.js';

export interface CreateAgentDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  instructions: string;
  ownerUserId: string;
  createdBy: string;
  origin?: AgentDefinition['origin'];
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
}

export interface AgentDefinitionUpdate {
  name?: string;
  description?: string;
  instructions?: string;
  status?: AgentDefinition['status'];
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
}
