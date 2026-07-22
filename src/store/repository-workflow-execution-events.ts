import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';

export type WorkflowExecutionEventType =
  | 'execution_created'
  | 'execution_status_changed'
  | 'run_created'
  | 'run_event'
  | 'approval_requested'
  | 'approval_decided'
  | 'output_created';

export interface WorkflowExecutionStreamEvent {
  id: string;
  schemaVersion: 1;
  executionId: string;
  type: WorkflowExecutionEventType;
  occurredAt: string;
  runId?: string;
  runEventSeq?: number;
  approvalId?: string;
  payload: Record<string, unknown>;
}

export interface InsertWorkflowExecutionEventInput {
  executionId: string;
  workspaceId: string;
  type: WorkflowExecutionEventType;
  dedupeKey: string;
  occurredAt?: string;
  runId?: string;
  runEventSeq?: number;
  approvalId?: string;
  payload?: Record<string, unknown>;
}

type Row = QueryResultRow;

function mapEvent(row: Row): WorkflowExecutionStreamEvent {
  const runPayload = row.run_event_type
    ? {
        schema_version: row.run_schema_version,
        run_id: row.run_id,
        seq: row.run_event_seq,
        ts: new Date(row.run_occurred_at).toISOString(),
        type: row.run_event_type,
        payload: row.run_payload || {}
      }
    : undefined;
  return {
    id: String(row.id),
    schemaVersion: 1,
    executionId: row.execution_id,
    type: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    runId: row.run_id || undefined,
    runEventSeq: row.run_event_seq ?? undefined,
    approvalId: row.approval_id || undefined,
    payload: runPayload ? { runEvent: runPayload } : (row.payload || {})
  };
}

const selectEvents = `
  SELECT event.*,
         run_event.schema_version AS run_schema_version,
         run_event.event_type AS run_event_type,
         run_event.occurred_at AS run_occurred_at,
         run_event.payload AS run_payload
    FROM workflow_execution_events event
    LEFT JOIN workflow_run_events run_event
      ON event.event_type='run_event'
     AND run_event.run_id=event.run_id
     AND run_event.seq=event.run_event_seq
`;

export async function insertWorkflowExecutionEvent(
  client: PoolClient,
  input: InsertWorkflowExecutionEventInput
): Promise<WorkflowExecutionStreamEvent | null> {
  const result = await client.query<Row>(
    `INSERT INTO workflow_execution_events (
       execution_id,workspace_id,event_type,run_id,run_event_seq,approval_id,dedupe_key,payload,occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (execution_id,dedupe_key) DO NOTHING
     RETURNING *`,
    [input.executionId, input.workspaceId, input.type, input.runId || null, input.runEventSeq || null,
     input.approvalId || null, input.dedupeKey, input.payload || {},
     input.occurredAt || new Date().toISOString()]
  );
  if (!result.rowCount) return null;
  const hydrated = await client.query<Row>(`${selectEvents} WHERE event.id=$1`, [result.rows[0].id]);
  return mapEvent(hydrated.rows[0]);
}

export async function appendWorkflowExecutionEvent(
  input: InsertWorkflowExecutionEventInput
): Promise<WorkflowExecutionStreamEvent | null> {
  const result = await db.query<Row>(
    `INSERT INTO workflow_execution_events (
       execution_id,workspace_id,event_type,run_id,run_event_seq,approval_id,dedupe_key,payload,occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (execution_id,dedupe_key) DO NOTHING
     RETURNING id`,
    [input.executionId, input.workspaceId, input.type, input.runId || null, input.runEventSeq || null,
     input.approvalId || null, input.dedupeKey, input.payload || {},
     input.occurredAt || new Date().toISOString()]
  );
  if (!result.rowCount) return null;
  const hydrated = await db.query<Row>(`${selectEvents} WHERE event.id=$1`, [result.rows[0].id]);
  return mapEvent(hydrated.rows[0]);
}

export async function listWorkflowExecutionEvents(
  executionId: string,
  afterId = 0
): Promise<WorkflowExecutionStreamEvent[]> {
  const result = await db.query<Row>(
    `${selectEvents}
      WHERE event.execution_id=$1 AND event.id>$2
      ORDER BY event.id`,
    [executionId, afterId]
  );
  return result.rows.map(mapEvent);
}
