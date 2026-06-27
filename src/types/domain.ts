export type Role = string;
export type RunStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'cancelling';
export type ToolAccessMode = 'read_only' | 'read_write';
export const TARGET_TYPES = ['kubernetes', 'virtual_machine'] as const;
export type TargetType = typeof TARGET_TYPES[number];
export const KUBERNETES_TARGET_TYPE: TargetType = 'kubernetes';
export const VIRTUAL_MACHINE_TARGET_TYPE: TargetType = 'virtual_machine';
export const TARGET_TYPE_DISPLAY_LIST = TARGET_TYPES.join(', ');

export function isTargetType(value: string): value is TargetType {
  return TARGET_TYPES.includes(value as TargetType);
}

export type WriteConfirmationPolicySource = 'cluster_override' | 'deployment_default';
export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ToolApprovalExecutionStatus = 'not_started' | 'executing' | 'succeeded' | 'failed' | 'unknown';
export type WebhookHistoryStatus = 'success' | 'failed';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  quota?: UserQuota;
}

export interface UserDisplay {
  id: string;
  displayName: string;
}

export type QuotaKey = 'workspaceMemberships' | 'workspaceMembers' | 'kubernetesClusters' | 'virtualMachines';

export interface QuotaUsage {
  used: number;
  limit: number;
}

export interface UserQuota {
  workspaceMemberships: QuotaUsage;
}

export interface WorkspaceQuota {
  members: QuotaUsage;
  kubernetesClusters: QuotaUsage;
  virtualMachines: QuotaUsage;
}

export interface PasswordAuthMethod {
  type: 'password';
  username: string;
  lastChangedAt: string;
  lastLoginAt?: string;
}

export interface OidcAuthMethod {
  type: 'oidc';
  provider: string;
  emailAtLinkTime: string;
  linkedAt: string;
  lastLoginAt?: string;
}

export type AuthMethod = PasswordAuthMethod | OidcAuthMethod;

export interface AuthMethods {
  methods: AuthMethod[];
  capabilities: {
    canChangePassword: boolean;
    canLinkOidc: boolean;
    canAddPassword: boolean;
  };
}

export interface Workspace {
  id: string;
  name: string;
  plan: WorkspacePlan;
  createdBy: string;
  createdAt: string;
}

export interface WorkspacePlan {
  key: WorkspacePlanKey;
  name: string;
}

export type WorkspacePlanKey = string;

export interface WorkspacePermissions {
  read_workspace_data: boolean;
  read_members: boolean;
  read_audit_log: boolean;
  delete_workspace: boolean;
  manage_members: boolean;
  manage_targets: boolean;
  manage_mcp: boolean;
  manage_tools: boolean;
  manage_skills: boolean;
  manage_ai_settings: boolean;
  manage_agent_keys: boolean;
  manage_webhooks: boolean;
  create_sessions: boolean;
  create_read_only_runs: boolean;
  create_read_write_runs: boolean;
  read_target_logs: boolean;
  cancel_runs: boolean;
  delete_sessions: boolean;
}

export type RoleTemplateKind = 'system' | 'custom';
export type RoleTemplateCapabilityGroupKey = 'workspace' | 'members' | 'targets' | 'operations' | 'settings';

export interface RoleTemplateCapabilityGroup {
  key: RoleTemplateCapabilityGroupKey;
  capabilities: Array<keyof WorkspacePermissions>;
  sortOrder: number;
}

export interface RoleTemplate {
  key: Role;
  displayName: string;
  description: string;
  kind: RoleTemplateKind;
  capabilities: Array<keyof WorkspacePermissions>;
  capabilityGroups?: RoleTemplateCapabilityGroup[];
  protected: boolean;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceSummary extends Workspace {
  currentUserRole: Role;
  currentUserRoleTemplate?: RoleTemplate;
  permissions: WorkspacePermissions;
  clusterCount: number;
  memberCount: number;
  quota: WorkspaceQuota;
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';
export type ReasoningSummaryMode = 'off' | 'auto' | 'concise' | 'detailed';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface WorkspaceAiSettings {
  workspaceId: string;
  defaultProvider: LlmProvider;
  defaultModel: string;
  reasoningSummaryMode: ReasoningSummaryMode;
  reasoningEffort: ReasoningEffort;
  createdAt?: string;
  updatedAt?: string;
}

export interface TargetSummary {
  id: string;
  workspaceId: string;
  targetType: TargetType;
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export type {
  TargetSkillBundleStats,
  TargetSkillDetail,
  TargetSkillFile,
  TargetSkillSource,
  TargetSkillSourceType,
  TargetSkillsCatalog,
  TargetSkillSummary,
  TargetSkillSyncStatus,
  TargetSkillValidationStatus
} from './target-skills.js';

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  roleTemplate?: RoleTemplate;
  source: 'oidc' | 'internal';
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: Role;
  roleTemplate?: RoleTemplate;
  invitedBy: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  acceptedBy?: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export type WorkspaceMembershipAuditAction = 'member_added' | 'member_role_updated' | 'member_removed';

export interface WorkspaceMembershipAudit {
  id: string;
  workspaceId: string;
  targetUserId: string;
  actorUserId: string;
  action: WorkspaceMembershipAuditAction;
  previousRole?: Role;
  nextRole?: Role;
  createdAt: string;
}

export const WORKSPACE_AUDIT_CATEGORIES = [
  'membership',
  'workspace',
  'target',
  'session',
  'run',
  'approval',
  'mcp',
  'tool'
] as const;

export type WorkspaceAuditCategory = typeof WORKSPACE_AUDIT_CATEGORIES[number];
export type WorkspaceAuditOperation = 'read' | 'write';
export type WorkspaceAuditLoggingMode = 'read_write' | 'write_only' | 'disabled';

export interface WorkspaceAuditActor {
  type: 'user' | 'system' | 'admin_token';
  userId?: string;
  tokenId?: string;
  email?: string;
  displayName?: string;
}

export interface WorkspaceAuditObject {
  type: string;
  id?: string;
  name?: string;
}

export interface WorkspaceAuditEvent {
  id: string;
  workspaceId: string;
  category: WorkspaceAuditCategory;
  eventType: string;
  operation: WorkspaceAuditOperation;
  actor: WorkspaceAuditActor;
  object: WorkspaceAuditObject;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface WorkspaceAuditEventInput {
  workspaceId: string;
  category: WorkspaceAuditCategory;
  eventType: string;
  operation: WorkspaceAuditOperation;
  actorUserId?: string | null;
  actorTokenId?: string | null;
  actorType?: 'user' | 'system' | 'admin_token';
  objectType: string;
  objectId?: string | null;
  objectName?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface KubernetesCluster {
  id: string;
  workspaceId: string;
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  namespaceInclude: string[];
  namespaceExclude: string[];
  writeConfirmationRequiredOverride?: boolean | null;
  writeConfirmationPolicy: {
    effectiveRequired: boolean;
    overrideRequired: boolean | null;
    source: WriteConfirmationPolicySource;
  };
  createdAt: string;
  updatedAt: string;
}

export interface VirtualMachineTarget {
  id: string;
  workspaceId: string;
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  hostname?: string;
  osFamily: 'linux';
  serviceManager: 'systemd';
  allowedLogSources: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VirtualMachineSnapshot {
  targetId: string;
  workspaceId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type {
  TargetIssue,
  TargetIssueObservation,
  TargetIssueSeverity,
  TargetIssueStatus
} from './target-issues.js';

export interface TargetAgentRegistration {
  targetId: string;
  targetType: TargetType;
  workspaceId: string;
  agentKeyHash: string;
  keyVersion: number;
  lastSeenAt?: string;
  lastHeartbeatAt?: string;
  lastConnectionId?: string;
  lastAgentVersion?: string;
  capabilities?: string[];
}

export interface ChatSession {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  createdBy: string;
  createdByUser?: UserDisplay;
  title: string;
  status: 'open' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export type ActiveRunStatus = Extract<RunStatus, 'queued' | 'dispatching' | 'running' | 'waiting_for_approval' | 'cancelling'>;

export interface RecentTargetChatActivity {
  sessionId: string;
  title: string;
  createdBy: string;
  createdByUser?: UserDisplay;
  lastActivityAt: string;
  lastRunId?: string;
  lastRunStatus?: RunStatus;
  activeRun?: {
    runId: string;
    status: ActiveRunStatus;
    toolAccessMode: ToolAccessMode;
    requestedAt: string;
  };
  hasActiveRun: boolean;
  hasRecentWriteCapableRun: boolean;
  latestToolAccessMode?: ToolAccessMode;
}

export interface TargetChatActivity {
  targetId: string;
  targetType: TargetType;
  targetName: string;
  windowSeconds: number;
  generatedAt: string;
  recentActivity: RecentTargetChatActivity[];
}

export type TargetChatActivityEventType =
  | 'message.created'
  | 'run.created'
  | 'run.status_changed'
  | 'assistant_message.committed'
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.expired'
  | 'session.deleted';

export interface TargetChatActivityEvent {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  sessionId: string;
  runId?: string;
  messageId?: string;
  approvalId?: string;
  type: TargetChatActivityEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant';
  kind: 'user' | 'assistant_final';
  content: string;
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
  createdAt: string;
}

export interface Run {
  id: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  sessionId: string;
  messageId: string;
  llmProvider: LlmProvider;
  llmModel: string;
  llmReasoningSummaryMode: ReasoningSummaryMode;
  llmReasoningEffort: ReasoningEffort;
  toolAccessMode: ToolAccessMode;
  status: RunStatus;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
    reasoning_tokens?: number;
  };
  assistantMessage?: {
    content: string;
    format: 'markdown';
  };
}

export interface RunEvent {
  schema_version: 1;
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface RunToolApproval {
  id: string;
  runId: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
  clusterId?: string;
  toolCallId: string;
  toolName: string;
  summary?: string;
  arguments: Record<string, unknown>;
  status: ToolApprovalStatus;
  executionStatus: ToolApprovalExecutionStatus;
  executionStartedAt?: string;
  executionFinishedAt?: string;
  toolResult?: unknown;
  toolResultIsError?: boolean;
  requestedBy?: string;
  decidedBy?: string;
  decision?: 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

export interface RunContinuation {
  runId: string;
  approvalId: string;
  schemaVersion: number;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ClusterSnapshot {
  clusterId: string;
  workspaceId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  targetId?: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  secretCiphertext: string;
  secretKeyId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookHistory {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  workspaceId: string;
  targetId?: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  status: WebhookHistoryStatus;
  responseStatus?: number;
  error?: string;
  durationMs?: number;
  sentAt: string;
}
