import type { TargetType, WorkspaceAuditOperation } from '../types/domain.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';

export type RunScopeType = 'target' | 'agent_chat' | 'workspace';

export interface NativeToolPermission {
  id: string;
  config: Record<string, unknown>;
}

export interface McpToolRef {
  serverId: string;
  toolName: string;
}

export interface RunPrincipalRef {
  type: 'user' | 'service_identity';
  id: string;
}

export type RunPermissionMode = 'read_only' | 'ask_before_changes' | 'auto_allowed_changes';

interface BaseRunScopeClaims {
  runId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
  principal?: RunPrincipalRef;
  permissionMode?: RunPermissionMode;
  allowedProviders: string[];
  allowedTools: string[];
  allowedToolRefs?: McpToolRef[];
  allowedNativeTools?: NativeToolPermission[];
  allowedToolOperations?: Record<string, WorkspaceAuditOperation>;
  maxOutputTokens?: number;
  allowedModels?: string[];
  resourceBindings?: PromptResourceBinding[];
  bindingDigest?: string;
}

export interface TargetRunScopeClaims extends BaseRunScopeClaims {
  scopeType?: 'target';
  targetId: string;
  targetType: TargetType;
}

export interface WorkflowRunScopeClaims extends BaseRunScopeClaims {
  scopeType: 'workspace';
  workflowId: string;
  executionId: string;
  workflowSessionId: string;
  executorRole: 'coordinator' | 'specialist';
  agentId?: string;
  triggerId?: string;
}

export interface AgentChatRunScopeClaims extends BaseRunScopeClaims {
  scopeType: 'agent_chat';
  agentId: string;
}

export type RunScopeClaims = TargetRunScopeClaims | AgentChatRunScopeClaims | WorkflowRunScopeClaims;

interface VerifiedBaseRunScopeClaims extends BaseRunScopeClaims {
  subject: string;
  tokenId?: string;
  allowedNativeTools: NativeToolPermission[];
  principal: RunPrincipalRef;
  permissionMode: RunPermissionMode;
  resourceBindings: PromptResourceBinding[];
  bindingDigest?: string;
}

export interface VerifiedTargetRunScopeClaims extends VerifiedBaseRunScopeClaims {
  scopeType: 'target';
  targetId: string;
  targetType: TargetType;
  workflowId?: never;
  executionId?: never;
  workflowSessionId?: never;
  executorRole?: never;
  agentId?: never;
  triggerId?: never;
}

export interface VerifiedAgentChatRunScopeClaims extends VerifiedBaseRunScopeClaims {
  scopeType: 'agent_chat';
  agentId: string;
  targetId?: never;
  targetType?: never;
  workflowId?: never;
  executionId?: never;
  workflowSessionId?: never;
  executorRole?: never;
  triggerId?: never;
}

export interface VerifiedWorkflowRunScopeClaims extends VerifiedBaseRunScopeClaims {
  scopeType: 'workspace';
  workflowId: string;
  executionId: string;
  workflowSessionId: string;
  executorRole: 'coordinator' | 'specialist';
  agentId?: string;
  triggerId?: string;
  targetId?: never;
  targetType?: never;
}

export type VerifiedRunScopeClaims =
  | VerifiedTargetRunScopeClaims
  | VerifiedAgentChatRunScopeClaims
  | VerifiedWorkflowRunScopeClaims;
