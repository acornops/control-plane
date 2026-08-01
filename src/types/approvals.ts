export interface WorkspaceApprovalInboxRow {
  approvalId: string;
  runId: string;
  source: 'interactive_tool' | 'workflow_gate' | 'workflow_tool';
  workflowId?: string;
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
