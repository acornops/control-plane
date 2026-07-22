import { config } from '../config.js';
import { db } from '../infra/db.js';
import type { Run, RunEvent } from '../types/domain.js';
import { mapRun, mapRunEvent } from './repository-mappers.js';

const runSelect = `
  SELECT r.*, t.target_type
  FROM runs r
  JOIN targets t ON t.id = r.target_id
`;

export async function addRun(run: Run): Promise<Run> {
  const result = await db.query(
    `WITH inserted AS (
       INSERT INTO runs (
         id, workspace_id, target_id, session_id, message_id,
         llm_provider, llm_model, llm_reasoning_summary_mode, llm_reasoning_effort,
         tool_access_mode,
         status, requested_at, started_at, ended_at,
         error_code, error_message, usage, assistant_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
       RETURNING *
     )
     SELECT inserted.*, t.target_type
     FROM inserted
     JOIN targets t ON t.id = inserted.target_id`,
    [
      run.id, run.workspaceId, run.targetId, run.sessionId, run.messageId,
      run.llmProvider, run.llmModel, run.llmReasoningSummaryMode, run.llmReasoningEffort,
      run.toolAccessMode, run.status, run.requestedAt, run.startedAt || null, run.endedAt || null,
      run.errorCode || null, run.errorMessage || null, JSON.stringify(run.usage || null),
      JSON.stringify(run.assistantMessage || null)
    ]
  );
  return mapRun(result.rows[0]);
}

export async function getRun(runId: string): Promise<Run | null> {
  const result = await db.query(`${runSelect} WHERE r.id = $1`, [runId]);
  return result.rowCount ? mapRun(result.rows[0]) : null;
}

export async function updateRun(runId: string, patch: Partial<Run>): Promise<Run | null> {
  const current = await getRun(runId);
  if (!current) return null;
  const next: Run = { ...current, ...patch };
  const result = await db.query(
    `WITH updated AS (
       UPDATE runs
       SET status = $2, started_at = $3, ended_at = $4, error_code = $5,
           error_message = $6, usage = $7::jsonb, assistant_message = $8::jsonb
       WHERE id = $1
       RETURNING *
     )
     SELECT updated.*, t.target_type
     FROM updated
     JOIN targets t ON t.id = updated.target_id`,
    [runId, next.status, next.startedAt || null, next.endedAt || null, next.errorCode || null,
      next.errorMessage || null, JSON.stringify(next.usage || null), JSON.stringify(next.assistantMessage || null)]
  );
  return mapRun(result.rows[0]);
}

export async function appendRunEvents(runId: string, events: RunEvent[]): Promise<RunEvent[]> {
  if (!config.PERSIST_RUN_EVENTS) return events;
  const accepted: RunEvent[] = [];
  for (const event of events) {
    const result = await db.query(
      `INSERT INTO run_events (run_id, seq, ts, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, seq) DO NOTHING
       RETURNING *`,
      [runId, event.seq, event.ts, event.type, JSON.stringify(event.payload || {})]
    );
    if (result.rowCount) accepted.push(mapRunEvent(result.rows[0]));
  }
  return accepted;
}

export async function getRunEvents(runId: string): Promise<RunEvent[]> {
  if (!config.PERSIST_RUN_EVENTS) return [];
  const result = await db.query('SELECT * FROM run_events WHERE run_id = $1 ORDER BY seq ASC', [runId]);
  return result.rows.map(mapRunEvent);
}

export async function getLatestRunEventSeq(runId: string): Promise<number> {
  if (!config.PERSIST_RUN_EVENTS) return 0;
  const result = await db.query<{ latest_seq: number }>(
    'SELECT COALESCE(MAX(seq), 0)::int AS latest_seq FROM run_events WHERE run_id = $1',
    [runId]
  );
  return Number(result.rows[0]?.latest_seq || 0);
}
