import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { TargetType } from '../types/domain.js';
import { toIso } from './repository-mappers.js';

type QueryClient = Pick<PoolClient, 'query'>;

interface TargetMetricHistoryDbRow {
  target_id: string;
  workspace_id: string;
  target_type: TargetType;
  sample_ts: Date | string;
  metrics: Record<string, unknown> | null;
}

export interface TargetMetricHistoryPoint {
  targetId: string;
  workspaceId: string;
  targetType: TargetType;
  timestamp: string;
  metrics: Record<string, unknown>;
}

function mapMetricHistoryRow(row: TargetMetricHistoryDbRow): TargetMetricHistoryPoint {
  return {
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    targetType: row.target_type,
    timestamp: toIso(row.sample_ts)!,
    metrics: row.metrics || {}
  };
}

export async function upsertTargetMetricSample(
  client: QueryClient,
  input: {
    targetId: string;
    workspaceId: string;
    targetType: TargetType;
    timestamp: string;
    metrics: Record<string, unknown> | null;
  }
): Promise<void> {
  if (!input.metrics || Object.keys(input.metrics).length === 0) return;
  await client.query(
    `INSERT INTO target_metric_history (
       target_id, workspace_id, target_type, sample_ts, metrics
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (target_id, sample_ts) DO UPDATE
     SET workspace_id = EXCLUDED.workspace_id,
         target_type = EXCLUDED.target_type,
         metrics = EXCLUDED.metrics,
         updated_at = NOW()`,
    [
      input.targetId,
      input.workspaceId,
      input.targetType,
      input.timestamp,
      JSON.stringify(input.metrics)
    ]
  );
}

export async function listTargetMetricHistory(
  targetId: string,
  options: {
    targetType?: TargetType;
    since?: string;
    limit?: number;
  } = {}
): Promise<TargetMetricHistoryPoint[]> {
  const params: Array<string | number> = [targetId];
  const clauses = ['target_id = $1'];
  if (options.targetType) {
    params.push(options.targetType);
    clauses.push(`target_type = $${params.length}`);
  }
  if (options.since) {
    params.push(options.since);
    clauses.push(`sample_ts >= $${params.length}`);
  }
  params.push(Math.max(1, Math.min(1000, options.limit ?? 100)));
  const result = await db.query<TargetMetricHistoryDbRow>(
    `SELECT target_id, workspace_id, target_type, sample_ts, metrics
     FROM target_metric_history
     WHERE ${clauses.join(' AND ')}
     ORDER BY sample_ts DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.reverse().map(mapMetricHistoryRow);
}

export async function purgeOldTargetMetricHistory(retentionDays: number, limit = 1000): Promise<number> {
  const result = await db.query(
    `WITH candidate AS (
       SELECT target_id, sample_ts
       FROM target_metric_history
       WHERE sample_ts < NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY sample_ts ASC
       LIMIT $2
     )
     DELETE FROM target_metric_history h
     USING candidate c
     WHERE h.target_id = c.target_id
       AND h.sample_ts = c.sample_ts`,
    [Math.max(1, retentionDays), Math.max(1, Math.min(5000, limit))]
  );
  return result.rowCount ?? 0;
}
