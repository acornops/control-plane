import type { ChatSession, TargetType, ToolApprovalExecutionStatus, ToolApprovalStatus, UserDisplay } from './domain.js';

export interface ApprovalDisplayContext {
  requestedByUser?: UserDisplay;
  decidedByUser?: UserDisplay;
  workspaceName?: string;
  targetName?: string;
}

export interface RunToolApproval extends ApprovalDisplayContext {
  id: string;
  runId: string;
  workspaceId: string;
  targetId?: string;
  targetType?: TargetType;
  clusterId?: string;
  toolCallId: string;
  toolName: string;
  toolRef: { serverId: string; toolName: string };
  requestedToolAlias: string;
  argumentsDigest: string;
  summary?: string;
  arguments: Record<string, unknown>;
  status: ToolApprovalStatus;
  executionStatus: ToolApprovalExecutionStatus;
  executionStartedAt?: string;
  executionFinishedAt?: string;
  toolResult?: unknown;
  toolResultIsError?: boolean;
  requestedBy?: string;
  sessionId?: string;
  sessionOrigin?: ChatSession['origin'];
  sessionTitle?: string;
  decidedBy?: string;
  decision?: 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

export interface WorkspaceApprovalInboxRow extends ApprovalDisplayContext {
  approvalId: string;
  runId: string;
  source: 'interactive_tool' | 'workflow_gate' | 'workflow_tool';
  workflowId?: string;
  targetId?: string;
  targetType?: TargetType;
  executionStatus?: ToolApprovalExecutionStatus;
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

export interface WorkspaceApprovalInboxResponse {
  items: WorkspaceApprovalInboxRow[];
  pendingCount: number;
  nextCursor?: string;
}
