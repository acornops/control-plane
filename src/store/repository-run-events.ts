import { config } from '../config.js';
import { db } from '../infra/db.js';
import { RunEvent } from '../types/domain.js';
import { mapRunEvent } from './repository-mappers.js';

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
