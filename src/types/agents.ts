import type { WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation, TargetType } from './domain.js';

export type AgentStatus = 'active' | 'disabled' | 'draft';
export type AgentDefinitionKind = 'manager' | 'specialist';
export type AgentReviewState = 'draft' | 'reviewed';
export type AgentProviderType = 'internal' | 'external';
export type AgentSystemRole = 'workflow_coordinator';
export type AgentTriggerType =
  | 'manual'
  | 'workflow'
  | 'schedule'
  | 'webhook'
  | 'target_event';
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
  principal?: RunPrincipalRef;
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
  lastStatus?: AgentActivityRecord['status'];
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
  kind: AgentDefinitionKind;
  systemRole?: AgentSystemRole;
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
  delegateAgentIds: string[];
  triggers: AgentTriggerDefinition[];
  activity: AgentActivitySummary;
  readiness: {
    status: AutomationReadinessStatus;
    reasons: string[];
  };
}

export type AgentDefinitionResponse = Omit<AgentDefinition, 'delegateAgentIds' | 'systemRole' | 'kind'> & {
  kind: 'specialist';
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
  clientRequestId?: string;
  targetId?: string;
  targetType?: TargetType;
  idempotencyKey?: string;
  agentSnapshot?: AgentDefinition;
  status: 'queued' | 'running' | 'waiting_for_approval' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
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
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  assistantMessage?: { content: string; format?: string };
  usage?: unknown;
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
    allowed_tool_refs: Array<{ server_id: string; tool_name: string }>;
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
  mcpTools: McpToolRef[];
  targetToolRefs: McpToolRef[];
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  permissionMode: RunPermissionMode;
  semanticCapabilityIds: string[];
  coordinationFunctions: string[];
  principal: RunPrincipalRef;
  targetScope: AgentTargetScope;
  exactTargets: Array<{ id: string; targetType: TargetType }>;
  resourceResolutionPhase: 'run_exact';
  jwtClaims: AgentJwtClaimPreview;
}
