import { getConfiguredRoleTemplate, getWorkspacePermissions, isSupportedRole } from '../auth/authorization.js';
import { config } from '../config.js';
import { ChatSession, KubernetesCluster, KUBERNETES_TARGET_TYPE, Message, Role, Run, RunContinuation, RunEvent, RunToolApproval, TargetAgentRegistration, TargetSummary, User, Workspace, WorkspaceInvitation, WorkspaceMembership, WorkspaceSummary } from '../types/domain.js';
import { buildWorkspaceQuota, resolveWorkspacePlan } from './repository-quotas.js';
import { mapLastRuntimeSelection, SessionRuntimeSelectionRow } from './repository-session-runtime.js';
export const toIso = (value: Date | string | null | undefined): string | undefined =>
  !value ? undefined : typeof value === 'string' ? value : value.toISOString();
const nullableNumber = (value: number | string | null | undefined): number | null => value == null ? null : Number(value);

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  email_verified_at?: Date | string | null;
  email_verification_required?: boolean;
  created_at: Date | string;
}

export interface PasswordCredentialRow {
  user_id: string;
  username: string;
  password_hash: string;
  last_login_at: Date | string | null;
  id: string;
  email: string;
  display_name: string;
  email_verified_at?: Date | string | null;
  email_verification_required?: boolean;
  created_at: Date | string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  plan_key?: string | null;
  created_by: string;
  created_at: Date | string;
  current_user_role?: Role;
  cluster_count?: number | string;
  virtual_machine_count?: number | string;
  member_count?: number | string;
  quota_override_members?: number | string | null;
  quota_override_kubernetes_clusters?: number | string | null;
  quota_override_virtual_machines?: number | string | null;
}

export interface WorkspaceMembershipRow {
  workspace_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  source: WorkspaceMembership['source'];
  created_at: Date | string;
  updated_at: Date | string;
}

export interface WorkspaceInvitationRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  email: string;
  role: Role;
  invited_by: string;
  status: WorkspaceInvitation['status'];
  accepted_by: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
}

export interface ClusterRow {
  id: string;
  workspace_id: string;
  target_type?: string;
  name: string;
  status: KubernetesCluster['status'];
  namespace_include: string[] | null;
  namespace_exclude: string[] | null;
  write_confirmation_required_override: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TargetRow {
  id: string;
  workspace_id: string;
  target_type: TargetSummary['targetType'];
  name: string;
  status: TargetSummary['status'];
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface SessionRow extends SessionRuntimeSelectionRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: ChatSession['targetType'];
  created_by: string;
  created_by_user_id?: string | null;
  created_by_display_name?: string | null;
  title: string;
  status: ChatSession['status'];
  created_at: Date | string;
  updated_at: Date | string;
  last_message_at: Date | string;
  expires_at: Date | string;
  deleted_at: Date | string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  role: Message['role'];
  kind: Message['kind'];
  content: string;
  metadata: Record<string, unknown> | null;
  client_message_id: string | null;
  created_at: Date | string;
}

export interface RunRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: Run['targetType'];
  session_id: string;
  message_id: string;
  llm_provider: Run['llmProvider'];
  llm_model: string;
  llm_reasoning_summary_mode: Run['llmReasoningSummaryMode'];
  llm_reasoning_effort: Run['llmReasoningEffort'];
  tool_access_mode: Run['toolAccessMode'];
  status: Run['status'];
  requested_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  usage: Run['usage'] | null;
  assistant_message: Run['assistantMessage'] | null;
}

export interface RunEventRow {
  run_id: string;
  seq: number;
  ts: Date | string;
  type: string;
  payload: Record<string, unknown>;
}

export interface RunToolApprovalRow {
  id: string;
  run_id: string;
  workspace_id: string;
  target_id: string;
  target_type: RunToolApproval['targetType'];
  tool_call_id: string;
  tool_name: string;
  summary: string | null;
  arguments: Record<string, unknown> | null;
  status: RunToolApproval['status'];
  execution_status: RunToolApproval['executionStatus'];
  execution_started_at: Date | string | null;
  execution_finished_at: Date | string | null;
  tool_result: unknown | null;
  tool_result_is_error: boolean | null;
  requested_by: string | null;
  decided_by: string | null;
  decision: 'approved' | 'rejected' | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  expires_at: Date | string;
}

export interface RunContinuationRow {
  run_id: string;
  approval_id: string;
  schema_version: number;
  state: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TargetAgentRegistrationRow {
  target_id: string;
  target_type: TargetAgentRegistration['targetType'];
  workspace_id: string;
  agent_key_hash: string;
  key_version: number;
  last_seen_at: Date | string | null;
  last_heartbeat_at: Date | string | null;
  last_connection_id: string | null;
  last_agent_version: string | null;
  capabilities: string[] | null;
}

export interface ClusterSnapshotRow {
  target_id: string;
  workspace_id: string;
  snapshot_ts: Date | string;
  data: Record<string, unknown>;
}

export interface TargetToolOverrideRow {
  target_id: string;
  tool_name: string;
  enabled: boolean;
}

export interface SessionListPage {
  items: ChatSession[];
  nextCursor?: string;
}

export interface CreateRunFromMessageResult {
  message: Message;
  run: Run;
  idempotent: boolean;
}

export type AddWorkspaceMemberResult =
  | { status: 'created'; member: WorkspaceMembership }
  | { status: 'already_exists' }
  | { status: 'workspace_not_found' };

export type UpdateWorkspaceMemberResult =
  | { status: 'updated'; member: WorkspaceMembership }
  | { status: 'not_found' }
  | { status: 'last_owner' };

export type DeleteWorkspaceMemberResult =
  | { status: 'deleted'; member: WorkspaceMembership }
  | { status: 'not_found' }
  | { status: 'last_owner' };

export type CreateWorkspaceInvitationResult =
  | { status: 'created'; invitation: WorkspaceInvitation }
  | { status: 'workspace_not_found' }
  | { status: 'already_member' };

export type AcceptWorkspaceInvitationResult =
  | { status: 'accepted'; member: WorkspaceMembership; workspaceId: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'unavailable' }
  | { status: 'email_unverified'; email: string }
  | { status: 'email_mismatch'; expectedEmail: string };

export type RevokeWorkspaceInvitationResult =
  | { status: 'revoked'; invitation: WorkspaceInvitation }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export type CreatePasswordUserResult =
  | { status: 'created'; user: User }
  | { status: 'email_exists' }
  | { status: 'username_exists' };

export interface PasswordCredentialWithUser {
  user: User;
  username: string;
  passwordHash: string;
  lastLoginAt?: string;
  emailVerifiedAt?: string;
  emailVerificationRequired: boolean;
}

export function encodeSessionCursor(lastMessageAt: string, sessionId: string): string {
  return Buffer.from(JSON.stringify({ lastMessageAt, sessionId })).toString('base64url');
}

export function decodeSessionCursor(cursor?: string): { lastMessageAt: string; sessionId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      lastMessageAt?: unknown;
      sessionId?: unknown;
    };
    if (typeof decoded.lastMessageAt !== 'string' || typeof decoded.sessionId !== 'string') {
      return null;
    }
    return {
      lastMessageAt: decoded.lastMessageAt,
      sessionId: decoded.sessionId
    };
  } catch {
    return null;
  }
}

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: toIso(row.created_at)!
  };
}

export function mapWorkspace(row: WorkspaceRow): Workspace {
  const plan = resolveWorkspacePlan(row.plan_key);
  return {
    id: row.id,
    name: row.name,
    plan: { key: plan.key, name: plan.name },
    createdBy: row.created_by,
    createdAt: toIso(row.created_at)!
  };
}

export function mapWorkspaceSummary(row: WorkspaceRow): WorkspaceSummary {
  const candidateRole = String(row.current_user_role || '');
  const role: Role = normalizeRole(candidateRole) || candidateRole;
  const permissions = getWorkspacePermissions(role);
  const memberCount = permissions.read_members ? Number(row.member_count ?? 0) : 0;
  return {
    ...mapWorkspace(row),
    currentUserRole: role,
    currentUserRoleTemplate: getConfiguredRoleTemplate(role),
    permissions,
    clusterCount: permissions.read_workspace_data ? Number(row.cluster_count ?? 0) : 0,
    memberCount,
    quota: buildWorkspaceQuota({
      planKey: row.plan_key,
      quotaOverrides: {
        members: nullableNumber(row.quota_override_members),
        kubernetesClusters: nullableNumber(row.quota_override_kubernetes_clusters),
        virtualMachines: nullableNumber(row.quota_override_virtual_machines)
      },
      members: memberCount,
      kubernetesClusters: Number(row.cluster_count ?? 0),
      virtualMachines: Number(row.virtual_machine_count ?? 0),
      canReadWorkspaceData: permissions.read_workspace_data
    })
  };
}

export function normalizeRole(value: unknown): Role | null {
  const role = String(value || '').trim();
  return isSupportedRole(role) ? role : null;
}

export function mapWorkspaceMembership(row: WorkspaceMembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    roleTemplate: getConfiguredRoleTemplate(row.role),
    source: row.source === 'oidc' ? 'oidc' : 'internal',
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapWorkspaceInvitation(row: WorkspaceInvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    roleTemplate: getConfiguredRoleTemplate(row.role),
    invitedBy: row.invited_by,
    status: row.status,
    acceptedBy: row.accepted_by || undefined,
    createdAt: toIso(row.created_at)!,
    expiresAt: toIso(row.expires_at)!,
    acceptedAt: toIso(row.accepted_at),
    revokedAt: toIso(row.revoked_at)
  };
}

export function displayNameFromEmail(email: string): string {
  return email.split('@')[0] || email;
}

export function mapCluster(row: ClusterRow): KubernetesCluster {
  const overrideRequired = row.write_confirmation_required_override;
  const hasOverride = typeof overrideRequired === 'boolean';
  const effectiveRequired = hasOverride ? overrideRequired : config.ASSISTANT_WRITE_CONFIRMATION_REQUIRED;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    namespaceInclude: Array.isArray(row.namespace_include) ? row.namespace_include : [],
    namespaceExclude: Array.isArray(row.namespace_exclude) ? row.namespace_exclude : [],
    writeConfirmationRequiredOverride: hasOverride ? overrideRequired : null,
    writeConfirmationPolicy: {
      effectiveRequired,
      overrideRequired: hasOverride ? overrideRequired : null,
      source: hasOverride ? 'cluster_override' : 'deployment_default'
    },
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapTarget(row: TargetRow): TargetSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetType: row.target_type,
    name: row.name,
    status: row.status,
    metadata: row.metadata || {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    clusterId: row.target_type === KUBERNETES_TARGET_TYPE ? row.target_id : undefined,
    createdBy: row.created_by,
    createdByUser: row.created_by_user_id && row.created_by_display_name
      ? {
          id: row.created_by_user_id,
          displayName: row.created_by_display_name
        }
      : undefined,
    title: row.title,
    status: row.status,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    lastMessageAt: toIso(row.last_message_at)!,
    lastRuntimeSelection: mapLastRuntimeSelection(row),
    expiresAt: toIso(row.expires_at)!,
    deletedAt: toIso(row.deleted_at)
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id || undefined,
    role: row.role,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata || undefined,
    clientMessageId: row.client_message_id || undefined,
    createdAt: toIso(row.created_at)!
  };
}

export function mapRun(row: RunRow): Run {
  const targetId = row.target_id;
  const targetType = row.target_type;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId,
    targetType,
    clusterId: targetType === KUBERNETES_TARGET_TYPE ? targetId : undefined,
    sessionId: row.session_id,
    messageId: row.message_id,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmReasoningSummaryMode: row.llm_reasoning_summary_mode || 'auto',
    llmReasoningEffort: row.llm_reasoning_effort || 'low',
    toolAccessMode: row.tool_access_mode || 'read_only',
    status: row.status,
    requestedAt: toIso(row.requested_at)!,
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined,
    usage: row.usage || undefined,
    assistantMessage: row.assistant_message || undefined
  };
}

export function mapRunEvent(row: RunEventRow): RunEvent {
  return {
    schema_version: 1,
    run_id: row.run_id,
    seq: row.seq,
    ts: toIso(row.ts)!,
    type: row.type,
    payload: row.payload || {}
  };
}

export function mapRunToolApproval(row: RunToolApprovalRow): RunToolApproval {
  const targetId = row.target_id;
  const targetType = row.target_type;
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    targetId,
    targetType,
    clusterId: targetType === KUBERNETES_TARGET_TYPE ? targetId : undefined,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    summary: row.summary || undefined,
    arguments: row.arguments || {},
    status: row.status,
    executionStatus: row.execution_status || 'not_started',
    executionStartedAt: toIso(row.execution_started_at),
    executionFinishedAt: toIso(row.execution_finished_at),
    toolResult: row.tool_result ?? undefined,
    toolResultIsError: row.tool_result_is_error ?? undefined,
    requestedBy: row.requested_by || undefined,
    decidedBy: row.decided_by || undefined,
    decision: row.decision || undefined,
    createdAt: toIso(row.created_at)!,
    decidedAt: toIso(row.decided_at),
    expiresAt: toIso(row.expires_at)!
  };
}

export function mapRunContinuation(row: RunContinuationRow): RunContinuation {
  return {
    runId: row.run_id,
    approvalId: row.approval_id,
    schemaVersion: row.schema_version,
    state: row.state || {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

export function mapTargetAgentRegistration(row: TargetAgentRegistrationRow): TargetAgentRegistration {
  return {
    targetId: row.target_id,
    targetType: row.target_type,
    workspaceId: row.workspace_id,
    agentKeyHash: row.agent_key_hash,
    keyVersion: row.key_version,
    lastSeenAt: toIso(row.last_seen_at),
    lastHeartbeatAt: toIso(row.last_heartbeat_at),
    lastConnectionId: row.last_connection_id || undefined,
    lastAgentVersion: row.last_agent_version || undefined,
    capabilities: row.capabilities || undefined
  };
}
