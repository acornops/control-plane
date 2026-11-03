import type { TargetType, ToolApprovalExecutionStatus, UserDisplay } from './domain.js';

export interface ApprovalDisplayContext {
  requestedByUser?: UserDisplay;
  decidedByUser?: UserDisplay;
  workspaceName?: string;
  targetName?: string;
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
