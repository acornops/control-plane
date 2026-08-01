import { KUBERNETES_TARGET_TYPE, type ChatSession, type RunToolApproval } from '../types/domain.js';

const toIso = (value: Date | string | null | undefined): string | undefined =>
  !value ? undefined : typeof value === 'string' ? value : value.toISOString();

export interface RunToolApprovalRow {
  id: string;
  run_id: string;
  workspace_id: string;
  target_id: string | null;
  target_type: RunToolApproval['targetType'] | null;
  tool_call_id: string;
  tool_name: string;
  server_id: string;
  server_tool_name: string;
  requested_tool_alias: string;
  arguments_digest: string;
  summary: string | null;
  arguments: Record<string, unknown> | null;
  status: RunToolApproval['status'];
  execution_status: RunToolApproval['executionStatus'];
  execution_started_at: Date | string | null;
  execution_finished_at: Date | string | null;
  tool_result: unknown | null;
  tool_result_is_error: boolean | null;
  requested_by: string | null;
  session_id?: string | null;
  session_origin?: ChatSession['origin'] | null;
  session_title?: string | null;
  decided_by: string | null;
  decision: 'approved' | 'rejected' | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  expires_at: Date | string;
}

export function mapRunToolApproval(row: RunToolApprovalRow): RunToolApproval {
  const targetId = row.target_id || undefined;
  const targetType = row.target_type || undefined;
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    targetId,
    targetType,
    clusterId: targetType === KUBERNETES_TARGET_TYPE ? targetId : undefined,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolRef: { serverId: row.server_id, toolName: row.server_tool_name },
    requestedToolAlias: row.requested_tool_alias,
    argumentsDigest: row.arguments_digest,
    summary: row.summary || undefined,
    arguments: row.arguments || {},
    status: row.status,
    executionStatus: row.execution_status || 'not_started',
    executionStartedAt: toIso(row.execution_started_at),
    executionFinishedAt: toIso(row.execution_finished_at),
    toolResult: row.tool_result ?? undefined,
    toolResultIsError: row.tool_result_is_error ?? undefined,
    requestedBy: row.requested_by || undefined,
    sessionId: row.session_id || undefined,
    sessionOrigin: row.session_origin || undefined,
    sessionTitle: row.session_title || undefined,
    decidedBy: row.decided_by || undefined,
    decision: row.decision || undefined,
    createdAt: toIso(row.created_at)!,
    decidedAt: toIso(row.decided_at),
    expiresAt: toIso(row.expires_at)!
  };
}
