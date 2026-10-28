import { db } from '../infra/db.js';

/** Cancellation observation does not require ownership of the execution lease. */
export async function listCancelledRunIds(runIds: string[]): Promise<string[]> {
  const result = await db.query<{ id: string }>(`
    SELECT id FROM runs WHERE id=ANY($1::text[]) AND status IN ('cancelling','cancelled')
    UNION
    SELECT id FROM workflow_runs WHERE id=ANY($1::text[])
      AND (status IN ('cancelling','cancelled') OR cancellation_requested_at IS NOT NULL)
  `, [runIds]);
  return result.rows.map((row) => row.id);
}
