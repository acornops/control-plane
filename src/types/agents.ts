import type { WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from './domain.js';

export type AgentStatus = 'active' | 'disabled' | 'draft';
export type AgentReviewState = 'draft' | 'reviewed';
export type AgentProviderType = 'internal' | 'external';
export type AutomationReadinessStatus = 'ready' | 'needs_setup' | 'blocked';
export type RunPermissionMode = 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';

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
  inherited?: boolean;
}

export interface AgentApprovalPolicy {
  mode: 'none' | 'before_write' | 'always';
  writeToolsRequireApproval: boolean;
}

export interface AgentTrustPolicy {
  level: 'restricted' | 'trusted';
  allowExternalData: boolean;
}

export interface AgentTargetAccessPolicy {
  mode: 'all' | 'allowlist' | 'denylist';
  targetIds: string[];
}

export interface AgentCapability {
  source: 'builtin_tool' | 'mcp_tool' | 'skill';
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
  avatarEmoji: string;
  description?: string;
  instructions: string;
  status: AgentStatus;
  reviewState: AgentReviewState;
  providerType: AgentProviderType;
  ownerUserId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  mcpServers: string[];
  mcpTools: McpToolRef[];
  mcpInstallations: AgentMcpInstallationSnapshot[];
  tools: string[];
  nativeToolConfigs: Record<string, Record<string, unknown>>;
  targetAccessPolicy?: AgentTargetAccessPolicy;
  skills: string[];
  skillInstallations: AgentSkillInstallationSnapshot[];
  approvalPolicy: AgentApprovalPolicy;
  trustPolicy: AgentTrustPolicy;
  permissionMode: RunPermissionMode;
  semanticCapabilityIds: string[];
  readiness: {
    status: AutomationReadinessStatus;
    reasons: string[];
  };
}

export type AgentDefinitionResponse = AgentDefinition & {
  capabilities: AgentCapability[];
  templateRef?: {
    templateId: string;
    recordKey: string;
  };
};

export interface AgentAccessActor {
  userId: string;
  role: string;
  permissions: WorkspacePermissions;
}
