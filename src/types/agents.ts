import type { WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation, TargetType } from './domain.js';

export type AgentStatus = 'active' | 'disabled' | 'draft';
export type AgentReviewState = 'draft' | 'reviewed';
export type AgentProviderType = 'internal' | 'external';
export type AutomationReadinessStatus = 'ready' | 'needs_setup' | 'blocked';
export type RunPermissionMode = 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';

export interface DefinitionOrigin {
  type: 'template' | 'manual';
  templateId?: string;
  templateVersion?: number;
}

export interface RunPrincipalRef {
  type: 'user' | 'service_identity';
  id: string;
}

export interface McpToolRef {
  serverId: string;
  toolName: string;
}

export interface AgentMcpInstallationSnapshot {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  credentialMode: 'none' | 'workspace' | 'individual';
  revision: number;
  targetConstraints: { targetTypes: TargetType[]; targetIds: string[] };
  provenance?: { sourceId: string; artifactName: string; version: string; digest: string; importedAt: string };
  tools: Array<McpToolRef & {
    alias: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    capability: 'read' | 'write';
    enabled: boolean;
    reviewState: 'pending' | 'approved' | 'rejected';
    riskLevel: 'read_only' | 'non_destructive_write' | 'high_risk' | 'destructive';
    autoAllowed: boolean;
  }>;
}

export interface AgentSkillInstallationSnapshot {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  contentDigest: string;
  source: {
    type: 'manual' | 'git' | 'template';
    provider?: 'github' | 'gitlab';
    url?: string;
    apiBaseUrl?: string;
    ref?: string;
    path?: string;
    pinnedCommit?: string;
  };
  files: Array<{ path: string; content: string; contentDigest: string }>;
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

export interface AgentWorkflowUsage {
  workflowRunCount: number;
  lastRunAt?: string;
  lastStatus?: 'queued' | 'dispatching' | 'running' | 'waiting_for_approval' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
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
  origin: DefinitionOrigin;
  reviewState: AgentReviewState;
  providerType: AgentProviderType;
  version: number;
  ownerUserId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  mcpServers: string[];
  mcpTools: McpToolRef[];
  mcpInstallations: AgentMcpInstallationSnapshot[];
  tools: string[];
  skills: string[];
  skillInstallations: AgentSkillInstallationSnapshot[];
  contextGrants: string[];
  targetScope: AgentTargetScope;
  approvalPolicy: AgentApprovalPolicy;
  trustPolicy: AgentTrustPolicy;
  permissionMode: RunPermissionMode;
  semanticCapabilityIds: string[];
  workflowUsage: AgentWorkflowUsage;
  readiness: {
    status: AutomationReadinessStatus;
    reasons: string[];
  };
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

export interface AgentAccessActor {
  userId: string;
  role: string;
  permissions: WorkspacePermissions;
}
