import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from './domain.js';
import type { AgentDefinition, AutomationReadinessStatus, McpToolRef, RunPermissionMode, RunPrincipalRef } from './agents.js';
import type { PromptResourceBinding } from './prompt-resources.js';
import type { CapabilityRoutingMapping } from './capability-routing.js';
import type { CapabilityAccessActor, CapabilityAccessMode, CapabilityRestrictionMode } from './capability-access.js';

export type WorkflowStatus = 'active' | 'draft' | 'paused';
export type WorkflowExecutionMode = 'direct' | 'coordinated';
export type WorkflowCapabilityMode = CapabilityAccessMode;
export type WorkflowCapabilityRestrictionMode = CapabilityRestrictionMode;
export type WorkflowContextGrant =
  | 'workspace_metadata'
  | 'audit_events'
  | string;

export interface WorkflowDefinitionForAccess {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status?: WorkflowStatus;
  prompt: string;
  agentIds: string[];
  executionMode: WorkflowExecutionMode;
  tags?: string[];
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
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
    source: 'workspace' | 'agent';
    provider?: 'github' | 'gitlab';
    serverId?: string;
    toolName?: string;
    agentId?: string;
  };
}

export type WorkflowCatalogSourceName = 'agents';

export interface WorkflowCatalogSourceAvailability {
  status: 'available' | 'empty' | 'unavailable' | 'error';
  message?: string;
  retryable?: boolean;
  errorCode?: string;
}

export interface WorkflowOptionsCatalog {
  agents: WorkflowOption[];
  sourceAvailability: Record<WorkflowCatalogSourceName, WorkflowCatalogSourceAvailability>;
}

export interface WorkflowSchedulePreview {
  valid: boolean;
  summary: string;
  nextRunTimes: string[];
  errors: Array<{ field: string; message: string }>;
}

export type WorkflowAccessActor = CapabilityAccessActor;

export interface WorkflowJwtClaimPreview {
  scope: { type: 'workspace' };
  workflow_id: string;
  executor_role: WorkflowExecutorRole;
  agent_id?: string;
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
    }
  | {
      role: 'specialist';
      agentId: string;
    };

export interface CompiledWorkflowAccessScope {
  workflowId: string;
  workspaceId: string;
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
  tools: string[];
  toolOperations: Record<string, WorkspaceAuditOperation>;
  nativeToolConfigs: Record<string, Record<string, unknown>>;
  enabledSkills: string[];
  contextGrants: string[];
  approvalGates: string[];
  permissionMode: RunPermissionMode;
  principal: RunPrincipalRef;
  executor: WorkflowExecutor;
  selectedAgentSnapshots: AgentDefinition[];
  routingMappingSnapshots: CapabilityRoutingMapping[];
  resourceBindings: PromptResourceBinding[];
  promptDigest?: string;
  bindingDigest?: string;
  resourceResolutionPhase: 'session_ceiling' | 'run_exact';
  coordinationFunctions: string[];
  jwtClaims: WorkflowJwtClaimPreview;
}

export type WorkflowCapabilityPreviewStatus = 'ready' | 'blocked';
export type WorkflowCapabilityPreviewReasonCode =
  | 'CAPABILITY_MAPPING_UNAVAILABLE'
  | 'MCP_CONNECTION_UNAVAILABLE';

export interface WorkflowCapabilityToolPreview {
  id: string;
  name: string;
  label: string;
  description?: string;
  access: 'read' | 'write';
  source: 'mcp' | 'builtin';
  serverId?: string;
  serverIds?: string[];
}

export interface WorkflowCapabilityAttachmentPreview {
  id: string;
  name: string;
}

interface WorkflowMcpRequirementPreviewBase {
  serverId: string;
  serverName: string;
  authType: 'bearer_token' | 'custom_header' | 'oauth';
  connectionState: 'connection_missing' | 'connection_error' | 'connected';
  authRequirement: {
    scope: 'workspace' | 'individual';
    credentialLabel: string;
    requiredInformation: Array<{ name: string; description: string }>;
  };
  action:
    | 'connect_mcp_server'
    | 'authorize_mcp_server'
    | 'select_authorization_server'
    | 'reauthorize_mcp_server'
    | 'verify_mcp_server'
    | 'none';
}

export type WorkflowMcpRequirementPreview = WorkflowMcpRequirementPreviewBase & {
  owningAgent: { id: string; name: string };
};

export interface WorkflowCapabilitiesPreview {
  workflowId: string;
  promptDigest: string;
  bindingDigest: string;
  mode: WorkflowCapabilityMode;
  semanticCapabilityIds: string[];
  checkedAt: string;
  status: WorkflowCapabilityPreviewStatus;
  reasonCodes: WorkflowCapabilityPreviewReasonCode[];
  tools: {
    read: WorkflowCapabilityToolPreview[];
    write: WorkflowCapabilityToolPreview[];
  };
  directMcpServers: WorkflowCapabilityAttachmentPreview[];
  enabledSkills: WorkflowCapabilityAttachmentPreview[];
  mcpRequirements: WorkflowMcpRequirementPreview[];
  approvalRequirements: string[];
  counts: {
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
  name: string;
  status: WorkflowScheduleStatus;
  cron: string;
  timezone: string;
  approvedContextGrants: string[];
  principal: WorkflowSchedulePrincipal;
  createdBy: WorkflowScheduleActorMetadata;
  updatedBy: WorkflowScheduleActorMetadata;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: WorkflowScheduleLastStatus;
  lastExecutionId?: string;
  lastRunId?: string;
  lastError?: string;
}

export interface WorkflowScheduleInput {
  workflowId: string;
  name: string;
  enabled?: boolean;
  status?: WorkflowScheduleStatus;
  cron: string;
  timezone: string;
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
  approvedContextGrants?: string[];
  principal?: WorkflowSchedulePrincipal;
}

export type WorkflowWebhookStatus = 'enabled' | 'paused';
export type WorkflowWebhookLastStatus = 'dispatched' | 'failed' | 'auto_paused' | 'rejected';

export interface WorkflowWebhookRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  status: WorkflowWebhookStatus;
  approvedContextGrants: string[];
  principal: WorkflowSchedulePrincipal;
  secretCiphertext: string;
  secretKeyId: string;
  createdBy: WorkflowScheduleActorMetadata;
  updatedBy: WorkflowScheduleActorMetadata;
  createdAt: string;
  updatedAt: string;
  lastReceivedAt?: string;
  lastStatus?: WorkflowWebhookLastStatus;
  lastExecutionId?: string;
  lastRunId?: string;
  lastError?: string;
}

export interface WorkflowWebhookInput {
  workflowId: string;
  name: string;
  enabled?: boolean;
  approvedContextGrants?: string[];
  principal: WorkflowSchedulePrincipal;
}

export interface WorkflowWebhookPatch {
  name?: string;
  enabled?: boolean;
  approvedContextGrants?: string[];
}

export type WorkflowExecutionStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'waiting_for_approval'
  | 'needs_review'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowExecutionOrigin =
  | {
      schemaVersion: 1;
      kind: 'manual' | 'external_integration';
      label: string;
    }
  | {
      schemaVersion: 1;
      kind: 'schedule';
      label: string;
      scheduleId: string;
    }
  | {
      schemaVersion: 1;
      kind: 'webhook';
      label: string;
      webhookId: string;
    }
  | {
      schemaVersion: 1;
      kind: 'historical_event';
      label: string;
    };

export interface WorkflowExecutionSummary {
  id: string;
  workspaceId: string;
  workflow: {
    id: string;
    name: string;
  };
  status: WorkflowExecutionStatus;
  origin: WorkflowExecutionOrigin;
  rootRun?: {
    id: string;
    requestedAt: string;
    startedAt?: string;
    endedAt?: string;
  };
  createdBy?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
}
