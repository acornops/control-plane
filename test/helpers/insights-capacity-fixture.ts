import { mock } from 'node:test';
import { db } from '../../src/infra/db.js';

/** Minimal persisted reservation fixture; lease/race behavior uses PostgreSQL tests. */
export function installInsightsCapacityFixture(): void {
  let reservation: Record<string, unknown> | null = null;
  const query = async (sql: string, params: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: null, rows: [] };
    if (sql.includes('SELECT plan_key,lifecycle_status')) return { rowCount: 1, rows: [{ plan_key: null, lifecycle_status: 'active' }] };
    if (sql.includes('SELECT capacity_run_id')) return { rowCount: 1, rows: [{ capacity_run_id: null }] };
    if (sql.includes('SELECT 1 FROM target_insights_checkpoint_jobs')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('count(*)::int AS used')) return { rowCount: 1, rows: [{ used: 0 }] };
    if (sql.includes('INSERT INTO workspace_run_reservations')) {
      reservation = { run_id: params[0], workspace_id: params[1], pool: params[2], state: 'queued', settled_at: null };
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT workspace_id FROM workspace_run_reservations')) return { rowCount: reservation ? 1 : 0, rows: reservation ? [reservation] : [] };
    if (sql.includes('SELECT * FROM workspace_run_reservations')) return { rowCount: reservation ? 1 : 0, rows: reservation ? [reservation] : [] };
    if (sql.includes('SELECT id FROM workspaces')) return { rowCount: 1, rows: [{ id: 'workspace-1' }] };
    if (sql.includes('SELECT 1 FROM workspace_lifecycle_outbox') || sql.includes('SELECT 1 FROM workspace_run_operations')
      || sql.includes('SELECT 1 FROM workspace_run_reservations')) return { rowCount: 0, rows: [] };
    if (sql.includes('UPDATE workspace_run_reservations') || sql.includes('UPDATE target_insights_checkpoint_jobs')) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected Insights capacity query: ${sql}`);
  };
  mock.method(db, 'connect', async () => ({ query, release() {} }));
  mock.method(db, 'query', query);
}
