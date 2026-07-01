import type { WorkspaceCapability, WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from './domain.js';

export type WorkflowStatus = 'active' | 'draft' | 'paused';
export type WorkflowCapabilityMode = 'read_only' | 'read_write';
export type WorkflowDefinitionSource = 'system' | 'user';
export type WorkflowCategory =
  | 'cluster-triage'
  | 'git-operations'
  | 'workspace-audit'
  | 'knowledge-capture'
  | 'release-operations'
  | 'incident-review'
  | 'security-review';
export type WorkflowContextGrant =
  | 'workspace_metadata'
  | 'audit_events'
  | 'selected_chat_sessions'
  | 'target_inventory'
  | string;

export type WorkflowInputType =
  | 'text'
  | 'select'
  | 'cluster'
  | 'repository'
  | 'mcp_server'
  | 'mcp_tool'
  | 'skill'
  | 'chat_session_list'
  | 'output_format'
  | 'approval_policy'
  | 'runtime'
  | 'retention';

export interface WorkflowInputDefinition {
  name: string;
  label: string;
  type: WorkflowInputType;
  required: boolean;
  optionSource?: string;
}

export interface WorkflowTargetBinding {
  type: 'none' | 'selected_target' | 'selected_cluster';
  targetType?: 'kubernetes' | 'vm';
  inputName?: string;
}

export interface WorkflowOutputArtifactDefinition {
  id: string;
  type: 'markdown' | 'pdf' | 'patch' | 'task_list' | string;
  title: string;
  required?: boolean;
}

export interface WorkflowStepDefinition {
  id: string;
  title: string;
  requiredInputs: string[];
  agentIds?: string[];
  targetBinding?: WorkflowTargetBinding;
  enabledSkills: string[];
  allowedMcpServers: string[];
  allowedTools: string[];
  contextGrants: WorkflowContextGrant[];
  approvalRequired: boolean;
  outputArtifacts?: WorkflowOutputArtifactDefinition[];
}

export interface WorkflowPolicyDefinition {
  mode: WorkflowCapabilityMode;
  maxRuntimeSeconds: number;
  retentionDays: number;
  approvalRequirements: string[];
}

export interface WorkflowDefinitionForAccess {
  id: string;
  workspaceId: string;
  version: number;
  source?: WorkflowDefinitionSource;
  templateId?: string;
  name: string;
  description?: string;
  status?: WorkflowStatus;
  category: WorkflowCategory;
  orchestratorAgentId: string;
  tags?: string[];
  inputs?: WorkflowInputDefinition[];
  enabledMcpServers?: string[];
  enabledSkills?: string[];
  requiredPermissions: WorkspaceCapability[];
  policy: WorkflowPolicyDefinition;
  steps: WorkflowStepDefinition[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  starterPrompt?: string;
}

export interface WorkflowOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface WorkflowOptionsCatalog {
  clusters: WorkflowOption[];
  repositories: WorkflowOption[];
  mcpServers: WorkflowOption[];
  mcpTools: WorkflowOption[];
  skills: WorkflowOption[];
  agents: WorkflowOption[];
  chatSessions: WorkflowOption[];
  outputFormats: WorkflowOption[];
  approvalPolicies: WorkflowOption[];
  runtimeLimits: WorkflowOption[];
  retentionPolicies: WorkflowOption[];
}

export interface WorkflowAccessActor {
  userId: string;
  role: string;
  permissions: WorkspacePermissions;
}

export interface WorkflowJwtClaimPreview {
  scope: { type: 'workspace' };
  workflow_id: string;
  workflow_version: number;
  agent_id?: string;
  agent_version?: number;
  trigger_id?: string;
  permissions: {
    allowed_tools: string[];
    allowed_tool_operations: Record<string, WorkspaceAuditOperation>;
    context_grants: string[];
  };
}

export interface CompiledWorkflowAccessScope {
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  actor: {
    userId: string;
    role: string;
  };
  mode: WorkflowCapabilityMode;
  requiredPermissions: WorkspaceCapability[];
  grantedCapabilities: WorkspaceCapability[];
  mcpServers: string[];
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  selectedAgents?: Array<{
    stepId: string;
    agentIds: string[];
    agentVersions: Record<string, number>;
  }>;
  jwtClaims: WorkflowJwtClaimPreview;
}

export type WorkflowScheduleStatus = 'enabled' | 'paused';
export type WorkflowScheduleLastStatus = 'dispatched' | 'failed' | 'auto_paused' | 'skipped';

export interface WorkflowScheduleActorMetadata {
  userId: string;
  displayName?: string;
}

export interface WorkflowScheduleRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: number;
  name: string;
  status: WorkflowScheduleStatus;
  cron: string;
  timezone: string;
  inputDefaults: Record<string, unknown>;
  approvedContextGrants: string[];
  createdBy: WorkflowScheduleActorMetadata;
  updatedBy: WorkflowScheduleActorMetadata;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: WorkflowScheduleLastStatus;
  lastError?: string;
}

export interface WorkflowScheduleInput {
  workflowId: string;
  name: string;
  enabled?: boolean;
  status?: WorkflowScheduleStatus;
  cron: string;
  timezone: string;
  inputDefaults?: Record<string, unknown>;
  approvedContextGrants?: string[];
}

export interface WorkflowSchedulePatch {
  workspaceId?: string;
  workflowId?: string;
  name?: string;
  enabled?: boolean;
  status?: WorkflowScheduleStatus;
  cron?: string;
  timezone?: string;
  inputDefaults?: Record<string, unknown>;
  approvedContextGrants?: string[];
}

export interface WorkflowApprovalInboxRow {
  approvalId: string;
  runId: string;
  source: 'target_tool' | 'workflow_gate';
  workflowId?: string;
  targetId?: string;
  targetType?: string;
  summary: string;
  toolName: string;
  requestedBy?: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decision?: 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  requestedAt: string;
}
