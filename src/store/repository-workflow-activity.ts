import type { QueryResultRow } from 'pg';

import { db } from '../infra/db.js';
import type {
  WorkflowExecutionOrigin,
  WorkflowExecutionStatus,
  WorkflowExecutionSummary
} from '../types/workflows.js';
import { encodeCursor, pageWithCursor, type PagedResult } from '../utils/pagination.js';

export interface WorkflowExecutionPageCursor {
  createdAt: string;
  executionId: string;
  signature?: string;
}

export interface WorkflowExecutionListOptions {
  limit: number;
  cursor?: WorkflowExecutionPageCursor | null;
  state?: 'all' | 'open' | 'attention' | 'completed' | 'failed' | 'cancelled';
  origin?: 'manual' | 'external_integration' | 'schedule' | 'webhook';
  workflowId?: string;
  search?: string;
  signature?: string;
}

const iso = (value: unknown): string | undefined =>
  value ? new Date(value as string).toISOString() : undefined;

export function mapWorkflowExecutionSummary(row: QueryResultRow): WorkflowExecutionSummary {
  const workflowSnapshot = row.workflow_snapshot && typeof row.workflow_snapshot === 'object'
    ? row.workflow_snapshot as Record<string, unknown>
    : {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflow: {
      id: row.workflow_id,
      name: typeof workflowSnapshot.name === 'string' ? workflowSnapshot.name : row.workflow_id
    },
    status: row.status as WorkflowExecutionStatus,
    origin: row.origin_snapshot as WorkflowExecutionOrigin,
    ...(row.root_run_id ? {
      rootRun: {
        id: row.root_run_id,
        requestedAt: iso(row.root_requested_at)!,
        ...(row.root_started_at ? { startedAt: iso(row.root_started_at) } : {}),
        ...(row.root_ended_at ? { endedAt: iso(row.root_ended_at) } : {})
      }
    } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: iso(row.created_at)!,
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
    updatedAt: iso(row.updated_at)!
  };
}

const summarySelect = `
  SELECT execution.*,
         root.id AS root_run_id,
         root.requested_at AS root_requested_at,
         root.started_at AS root_started_at,
         root.ended_at AS root_ended_at
    FROM workflow_executions execution
    LEFT JOIN LATERAL (
      SELECT run.id,run.requested_at,run.started_at,run.ended_at
        FROM workflow_runs run
       WHERE run.execution_id=execution.id AND run.parent_run_id IS NULL
       ORDER BY run.attempt_number DESC,run.id DESC
       LIMIT 1
    ) root ON TRUE
`;

export async function getWorkflowExecutionSummary(
  executionId: string
): Promise<WorkflowExecutionSummary | null> {
  const result = await db.query<QueryResultRow>(
    `${summarySelect} WHERE execution.id=$1`,
    [executionId]
  );
  return result.rowCount ? mapWorkflowExecutionSummary(result.rows[0]) : null;
}

export async function listWorkflowExecutionSummariesByIds(
  executionIds: string[]
): Promise<Map<string, WorkflowExecutionSummary>> {
  if (executionIds.length === 0) return new Map();
  const result = await db.query<QueryResultRow>(
    `${summarySelect} WHERE execution.id=ANY($1::text[])`,
    [executionIds]
  );
  return new Map(result.rows.map((row) => {
    const summary = mapWorkflowExecutionSummary(row);
    return [summary.id, summary];
  }));
}

export async function listWorkspaceWorkflowExecutions(
  workspaceId: string,
  options: WorkflowExecutionListOptions
): Promise<PagedResult<WorkflowExecutionSummary> & {
  summary: { openCount: number; attentionCount: number; latestUpdatedAt?: string };
}> {
  const limit = Math.max(1, Math.min(100, options.limit));
  const params: Array<string | number> = [workspaceId];
  const clauses = ['execution.workspace_id=$1'];
  const add = (sql: string, value: string): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (options.state === 'open') {
    clauses.push("execution.status NOT IN ('completed','failed','cancelled')");
  } else if (options.state === 'attention') {
    clauses.push("execution.status IN ('waiting_for_approval','needs_review')");
  } else if (options.state && options.state !== 'all') {
    add('execution.status=?', options.state);
  }
  if (options.origin) add("execution.origin_snapshot->>'kind'=?", options.origin);
  if (options.workflowId) add('execution.workflow_id=?', options.workflowId);
  if (options.search) {
    add(`POSITION(LOWER(?) IN LOWER(CONCAT_WS(
      ' ',
      execution.id,
      execution.workflow_id,
      execution.workflow_snapshot->>'name',
      execution.origin_snapshot->>'label',
      execution.origin_snapshot#>>'{source,label}'
    ))) > 0`, options.search);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.executionId);
    clauses.push(
      `(execution.created_at,execution.id) < ($${params.length - 1}::timestamptz,$${params.length}::text)`
    );
  }
  params.push(limit + 1);
  const result = await db.query<QueryResultRow>(
    `${summarySelect}
      WHERE ${clauses.join(' AND ')}
      ORDER BY execution.created_at DESC,execution.id DESC
      LIMIT $${params.length}`,
    params
  );
  const mapped = result.rows.map(mapWorkflowExecutionSummary);
  const page = pageWithCursor(mapped, limit, (item) => encodeCursor({
    signature: options.signature || '',
    createdAt: item.createdAt,
    executionId: item.id
  }));
  const counts = await db.query<{
    open_count: number;
    attention_count: number;
    latest_updated_at: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('completed','failed','cancelled'))::int AS open_count,
       COUNT(*) FILTER (WHERE status IN ('waiting_for_approval','needs_review'))::int AS attention_count,
       MAX(updated_at) AS latest_updated_at
     FROM workflow_executions
     WHERE workspace_id=$1`,
    [workspaceId]
  );
  return {
    ...page,
    summary: {
      openCount: Number(counts.rows[0]?.open_count || 0),
      attentionCount: Number(counts.rows[0]?.attention_count || 0),
      ...(counts.rows[0]?.latest_updated_at
        ? { latestUpdatedAt: iso(counts.rows[0].latest_updated_at) }
        : {})
    }
  };
}
