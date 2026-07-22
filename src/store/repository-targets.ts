import { db } from '../infra/db.js';
import { TargetSummary, TargetType } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { mapTarget, TargetRow } from './repository-mappers.js';

export async function listTargets(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: { createdAt: string; targetId: string } | null;
    q?: string;
    targetType?: TargetType;
    signature?: string;
  } = {}
): Promise<PagedResult<TargetSummary>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [workspaceId, limit + 1];
  const clauses = ['workspace_id = $1'];
  if (options.targetType) {
    params.push(options.targetType);
    clauses.push(`target_type = $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q.toLowerCase()}%`);
    clauses.push(`LOWER(name) LIKE $${params.length}`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.targetId);
    clauses.push(`(created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map(mapTarget), limit, (target) =>
    encodeCursor({
      signature: options.signature || '',
      createdAt: target.createdAt,
      targetId: target.id
    })
  );
}

export async function getTarget(workspaceId: string, targetId: string): Promise<TargetSummary | null> {
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE workspace_id = $1
       AND id = $2`,
    [workspaceId, targetId]
  );
  if (!result.rowCount) return null;
  return mapTarget(result.rows[0]);
}

export async function listWorkflowTargetSnapshot(workspaceId: string): Promise<TargetSummary[]> {
  const result = await db.query<TargetRow>(
    `SELECT id, workspace_id, target_type, name, status, metadata, created_at, updated_at
     FROM targets
     WHERE workspace_id = $1
     ORDER BY name ASC, id ASC`,
    [workspaceId]
  );
  return result.rows.map(mapTarget);
}
