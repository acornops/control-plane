import type { WorkspaceCapability, WorkspacePermissions } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from './domain.js';
import type { AgentDefinition, AutomationReadinessStatus, McpToolRef, RunPermissionMode, RunPrincipalRef } from './agents.js';
import type { DefinitionOrigin } from './agents.js';
import type { TargetType } from './domain.js';
import type { PromptResourceBinding, PromptResourceRequirement } from './prompt-resources.js';
import type { CapabilityRoutingMapping } from './capability-routing.js';

export type WorkflowStatus = 'active' | 'draft' | 'paused';
export type WorkflowExecutionMode = 'direct' | 'coordinated';
export type WorkflowCapabilityMode = 'read_only' | 'read_write';
export type WorkflowCapabilityRestrictionMode = 'inherit' | 'restrict';
export type WorkflowContextGrant =
  | 'workspace_metadata'
  | 'audit_events'
  | 'target_inventory'
  | string;

export type WorkflowInputType =
  | 'text'
  | 'select'
  | 'mcp_server'
  | 'mcp_tool'
  | 'skill'
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

export interface WorkflowCapabilityPolicy {
  mode: WorkflowCapabilityMode;
  restrictionMode: WorkflowCapabilityRestrictionMode;
  semanticCapabilityIds: string[];
  contextGrants: WorkflowContextGrant[];
  maxRuntimeSeconds: number;
  retentionDays: number;
  approvalRequirements: string[];
}

export interface WorkflowDefinitionForAccess {
  id: string;
  workspaceId: string;
  version: number;
  origin: DefinitionOrigin;
  name: string;
  description?: string;
  status?: WorkflowStatus;
  prompt: string;
  agentIds: string[];
  executionMode: WorkflowExecutionMode;
  resourceRequirements: PromptResourceRequirement[];
  capabilityPolicy: WorkflowCapabilityPolicy;
  tags?: string[];
  inputs?: WorkflowInputDefinition[];
  requiredPermissions: WorkspaceCapability[];
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
  starterPrompt?: string;
  readiness?: {
    status: AutomationReadinessStatus;
    reasons: string[];
  };
}

export type PublicWorkflowDefinition = WorkflowDefinitionForAccess;

export interface WorkflowOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  provenance?: {
    source: 'workspace' | 'target' | 'agent';
    provider?: 'github' | 'gitlab';
    targetId?: string;
    targetName?: string;
    targetType?: TargetType;
    serverId?: string;
    toolName?: string;
    agentId?: string;
  };
}

export type WorkflowCatalogSourceName =
  | 'mcpServers'
  | 'mcpTools'
  | 'skills'
  | 'agents';

export interface WorkflowCatalogSourceAvailability {
  status: 'available' | 'empty' | 'unavailable' | 'error';
  message?: string;
  retryable?: boolean;
  errorCode?: string;
}

export interface WorkflowOptionsCatalog {
  mcpServers: WorkflowOption[];
  mcpTools: WorkflowOption[];
  skills: WorkflowOption[];
  agents: WorkflowOption[];
  outputFormats: WorkflowOption[];
  approvalPolicies: WorkflowOption[];
  runtimeLimits: WorkflowOption[];
  retentionPolicies: WorkflowOption[];
  sourceAvailability: Record<WorkflowCatalogSourceName, WorkflowCatalogSourceAvailability>;
}

export interface WorkflowSchedulePreview {
  valid: boolean;
  summary: string;
  nextRunTimes: string[];
  errors: Array<{ field: string; message: string }>;
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
  executor_role: WorkflowExecutorRole;
  agent_id?: string;
  agent_version?: number;
  trigger_id?: string;
  permissions: {
    allowed_tools: string[];
    allowed_tool_refs: Array<{ server_id: string; tool_name: string }>;
    allowed_tool_operations: Record<string, WorkspaceAuditOperation>;
    context_grants: string[];
    resource_bindings: Array<{
      binding_id: string;
      type: string;
      resource_id: string;
      provider: string;
      operations: string[];
    }>;
    binding_digest?: string;
  };
}

export type WorkflowExecutorRole = 'coordinator' | 'specialist';

export type WorkflowExecutor =
  | {
      role: 'coordinator';
      profileVersion: number;
    }
  | {
      role: 'specialist';
      agentId: string;
      agentVersion: number;
    };

export interface CompiledWorkflowAccessScope {
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  actor: {
    userId: string;
    role: string;
  };
  mode: WorkflowCapabilityMode;
  semanticCapabilityIds: string[];
  capabilityRestrictionMode: WorkflowCapabilityRestrictionMode;
  requiredPermissions: WorkspaceCapability[];
  grantedCapabilities: WorkspaceCapability[];
  mcpServers: string[];
  mcpTools: McpToolRef[];
  targetToolRefs: McpToolRef[];
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  nativeToolConfigs: Record<string, Record<string, unknown>>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  permissionMode: RunPermissionMode;
  principal: RunPrincipalRef;
  executor: WorkflowExecutor;
  selectedAgents: Array<{ id: string; version: number }>;
  selectedAgentSnapshots: AgentDefinition[];
  routingMappingSnapshots: CapabilityRoutingMapping[];
  resourceBindings: PromptResourceBinding[];
  promptDigest?: string;
  bindingDigest?: string;
  resourceResolutionPhase: 'session_ceiling' | 'run_exact';
  coordinationFunctions: string[];
  jwtClaims: WorkflowJwtClaimPreview;
}

export type WorkflowCapabilityPreviewStatus = 'needs_target' | 'ready' | 'blocked';
export type WorkflowTargetCandidateStatus = 'ready' | 'unavailable' | 'unsupported';
export type WorkflowCapabilityPreviewReasonCode =
  | 'TARGET_REQUIRED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_TYPE_MISMATCH'
  | 'TARGET_OFFLINE'
  | 'TARGET_STATUS_UNKNOWN'
  | 'TARGET_WRITE_UNSUPPORTED'
  | 'CAPABILITY_MAPPING_UNAVAILABLE'
  | 'TARGET_TOOL_MAPPING_UNAVAILABLE'
  | 'TARGET_TOOL_CATALOG_UNAVAILABLE'
  | 'MCP_CONNECTION_UNAVAILABLE';

export interface WorkflowTargetCapabilityCandidate {
  id: string;
  name: string;
  targetType: TargetType;
  status: WorkflowTargetCandidateStatus;
  reasonCode?: WorkflowCapabilityPreviewReasonCode;
  reason?: string;
}

export interface WorkflowCapabilityToolPreview {
  id: string;
  name: string;
  label: string;
  description?: string;
  access: 'read' | 'write';
  source: 'target' | 'mcp' | 'builtin';
  serverId?: string;
}

export interface WorkflowCapabilityAttachmentPreview {
  id: string;
  name: string;
}

interface WorkflowMcpRequirementPreviewBase {
  serverId: string;
  serverName: string;
  authType: 'bearer_token' | 'custom_header';
  connectionState: 'connection_missing' | 'connection_error' | 'connected';
  authRequirement: {
    scope: 'workspace' | 'individual';
    credentialLabel: string;
    requiredInformation: Array<{ name: string; description: string }>;
  };
  action: 'connect_mcp_server' | 'verify_mcp_server' | 'none';
}

export type WorkflowMcpRequirementPreview = WorkflowMcpRequirementPreviewBase & (
  | {
      owningAgent: { id: string; name: string };
      owningTarget?: never;
    }
  | {
      owningAgent?: never;
      owningTarget: { id: string; name: string; targetType: TargetType };
    }
);

export interface WorkflowCapabilitiesPreview {
  workflowId: string;
  workflowVersion: number;
  mode: WorkflowCapabilityMode;
  semanticCapabilityIds: string[];
  checkedAt: string;
  status: WorkflowCapabilityPreviewStatus;
  reasonCodes: WorkflowCapabilityPreviewReasonCode[];
  targetCandidates: WorkflowTargetCapabilityCandidate[];
  selectedTarget?: WorkflowTargetCapabilityCandidate;
  tools: {
    read: WorkflowCapabilityToolPreview[];
    write: WorkflowCapabilityToolPreview[];
  };
  directMcpServers: WorkflowCapabilityAttachmentPreview[];
  enabledSkills: WorkflowCapabilityAttachmentPreview[];
  mcpRequirements: WorkflowMcpRequirementPreview[];
  approvalRequirements: string[];
  counts: {
    targets: number;
    readyTargets: number;
    tools: number;
    readTools: number;
    writeTools: number;
    directMcpServers: number;
    enabledSkills: number;
    approvals: number;
  };
}

export type WorkflowScheduleStatus = 'enabled' | 'paused';
export type WorkflowScheduleLastStatus = 'dispatched' | 'failed' | 'auto_paused' | 'skipped';

export interface WorkflowScheduleActorMetadata {
  userId: string;
  displayName?: string;
}

export interface WorkflowSchedulePrincipal {
  type: 'user';
  id: string;
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
  controlMessage: string;
  approvedContextGrants: string[];
  principal: WorkflowSchedulePrincipal;
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
  controlMessage: string;
  approvedContextGrants?: string[];
  principal: WorkflowSchedulePrincipal;
}

export interface WorkflowSchedulePatch {
  workspaceId?: string;
  workflowId?: string;
  name?: string;
  enabled?: boolean;
  status?: WorkflowScheduleStatus;
  cron?: string;
  timezone?: string;
  controlMessage?: string;
  approvedContextGrants?: string[];
  principal?: WorkflowSchedulePrincipal;
}

export interface WorkflowApprovalInboxRow {
  approvalId: string;
  runId: string;
  source: 'target_tool' | 'workflow_gate' | 'workflow_tool';
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

export interface WorkflowApprovalInboxResponse {
  items: WorkflowApprovalInboxRow[];
  pendingCount: number;
  nextCursor?: string;
}
