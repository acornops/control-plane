import type { WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation, TargetType } from './domain.js';

export type AgentStatus = 'active' | 'disabled' | 'draft';
export type AgentDefinitionSource = 'system' | 'user';
export type AgentProviderType = 'internal' | 'external';
export type AgentTriggerType =
  | 'manual'
  | 'workflow_step'
  | 'schedule'
  | 'webhook'
  | 'audit_event'
  | 'target_event'
  | 'external_adapter';

export interface AgentTriggerDefinition {
  id: string;
  type: AgentTriggerType;
  enabled: boolean;
  name?: string;
  schedule?: {
    cron: string;
    timezone: string;
  };
  eventFilter?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface AgentApprovalPolicy {
  mode: 'none' | 'before_write' | 'always';
  writeToolsRequireApproval: boolean;
}

export interface AgentTrustPolicy {
  level: 'restricted' | 'trusted';
  allowExternalData: boolean;
}

export interface AgentTargetScope {
  type: 'workspace' | 'selected_target';
  targetTypes?: TargetType[];
  targetIds?: string[];
}

export interface AgentActivitySummary {
  runCount: number;
  lastRunAt?: string;
  lastStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface AgentCapability {
  source: 'builtin_tool' | 'mcp_tool' | 'skill' | 'context' | 'target';
  providerAgentId?: string;
  resourceType: string;
  resourceScope: string;
  toolId?: string;
  operation: WorkspaceAuditOperation;
  requiresApproval: boolean;
}

export interface AgentDefinition {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  instructions: string;
  status: AgentStatus;
  source: AgentDefinitionSource;
  providerType: AgentProviderType;
  version: number;
  ownerUserId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  mcpServers: string[];
  tools: string[];
  skills: string[];
  contextGrants: string[];
  targetScope: AgentTargetScope;
  approvalPolicy: AgentApprovalPolicy;
  trustPolicy: AgentTrustPolicy;
  triggers: AgentTriggerDefinition[];
  activity: AgentActivitySummary;
}

export type AgentDefinitionResponse = AgentDefinition & {
  capabilities: AgentCapability[];
  workflowsUsingAgent: string[];
};

export interface AgentVersionSnapshot {
  id: string;
  agentId: string;
  workspaceId: string;
  version: number;
  snapshot: AgentDefinition;
  createdBy: string;
  createdAt: string;
}

export interface AgentActivityRecord {
  id: string;
  agentId: string;
  workspaceId: string;
  agentVersion: number;
  triggerId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggeredBy: {
    type: 'user' | 'workflow' | 'schedule' | 'webhook' | 'system';
    userId?: string;
    workflowId?: string;
  };
  inputContext: Record<string, unknown>;
  compiledScope: CompiledAgentRunScope;
  toolCalls: Array<{
    name: string;
    operation: WorkspaceAuditOperation;
    status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
    requestedAt: string;
  }>;
  outputArtifacts: Array<{
    id: string;
    type: string;
    title: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAccessActor {
  userId: string;
  role: string;
  permissions: WorkspacePermissions;
}

export interface AgentJwtClaimPreview {
  scope: { type: 'workspace' };
  agent_id: string;
  agent_version: number;
  trigger_id?: string;
  permissions: {
    allowed_tools: string[];
    allowed_tool_operations: Record<string, WorkspaceAuditOperation>;
    context_grants: string[];
  };
}

export interface CompiledAgentRunScope {
  agentId: string;
  workspaceId: string;
  agentVersion: number;
  triggerId?: string;
  actor: {
    userId: string;
    role: string;
  };
  mcpServers: string[];
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  targetScope: AgentTargetScope;
  jwtClaims: AgentJwtClaimPreview;
}
