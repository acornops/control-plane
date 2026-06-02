import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { sanitizeAuditMetadata } from './repository-audit-events.js';
import { toIso } from './repository-mappers.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';

interface Queryable {
  query: PoolClient['query'];
}

export interface AdminAuditEvent {
  id: string;
  adminTokenId?: string;
  action: string;
  outcome: 'success' | 'failure';
  workspaceId?: string;
  targetType?: string;
  targetId?: string;
  subjectType?: string;
  subjectId?: string;
  reason?: string;
  requestId: string;
  sourceIpHash?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface AdminAuditEventInput {
  adminTokenId?: string | null;
  action: string;
  outcome: 'success' | 'failure';
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  reason?: string | null;
  requestId: string;
  sourceIp?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

interface AdminAuditEventRow {
  id: string;
  admin_token_id: string | null;
  action: string;
  outcome: 'success' | 'failure';
  workspace_id: string | null;
  target_type: string | null;
  target_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  reason: string | null;
  request_id: string;
  source_ip_hash: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | string | null;
  occurred_at: Date | string;
}

function sourceIpHash(sourceIp: string | null | undefined): string | null {
  if (!sourceIp) return null;
  return createHash('sha256').update(sourceIp).digest('hex');
}

function mapAdminAuditEvent(row: AdminAuditEventRow): AdminAuditEvent {
  const metadata = typeof row.metadata === 'string'
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : row.metadata || {};
  return {
    id: row.id,
    ...(row.admin_token_id ? { adminTokenId: row.admin_token_id } : {}),
    action: row.action,
    outcome: row.outcome,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.target_type ? { targetType: row.target_type } : {}),
    ...(row.target_id ? { targetId: row.target_id } : {}),
    ...(row.subject_type ? { subjectType: row.subject_type } : {}),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    requestId: row.request_id,
    ...(row.source_ip_hash ? { sourceIpHash: row.source_ip_hash } : {}),
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    metadata,
    occurredAt: toIso(row.occurred_at)!
  };
}

export async function insertAdminAuditEvent(
  input: AdminAuditEventInput,
  queryable: Queryable = db
): Promise<AdminAuditEvent> {
  const result = await queryable.query(
    `INSERT INTO admin_audit_events (
       id, admin_token_id, action, outcome, workspace_id, target_type, target_id,
       subject_type, subject_id, reason, request_id, source_ip_hash, user_agent, metadata, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW())
     RETURNING *`,
    [
      randomUUID(),
      input.adminTokenId || null,
      input.action,
      input.outcome,
      input.workspaceId || null,
      input.targetType || null,
      input.targetId || null,
      input.subjectType || null,
      input.subjectId || null,
      input.reason || null,
      input.requestId,
      sourceIpHash(input.sourceIp),
      input.userAgent || null,
      JSON.stringify(sanitizeAuditMetadata(input.metadata))
    ]
  );
  return mapAdminAuditEvent(result.rows[0] as AdminAuditEventRow);
}

export async function listAdminAuditEvents(options: {
  limit?: number;
  cursor?: { occurredAt: string; eventId: string } | null;
  adminTokenId?: string;
  action?: string;
  outcome?: 'success' | 'failure';
  workspaceId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  signature?: string;
} = {}): Promise<PagedResult<AdminAuditEvent>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [limit + 1];
  const clauses: string[] = [];
  const addFilter = (sql: string, value: string): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (options.adminTokenId) addFilter('admin_token_id = ?', options.adminTokenId);
  if (options.action) addFilter('action = ?', options.action);
  if (options.outcome) addFilter('outcome = ?', options.outcome);
  if (options.workspaceId) addFilter('workspace_id = ?', options.workspaceId);
  if (options.targetType) addFilter('target_type = ?', options.targetType);
  if (options.targetId) addFilter('target_id = ?', options.targetId);
  if (options.from) addFilter('occurred_at >= ?::timestamptz', options.from);
  if (options.to) addFilter('occurred_at <= ?::timestamptz', options.to);
  if (options.cursor) {
    params.push(options.cursor.occurredAt, options.cursor.eventId);
    clauses.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT *
     FROM admin_audit_events
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $1`,
    params
  );
  return pageWithCursor(result.rows.map((row) => mapAdminAuditEvent(row as AdminAuditEventRow)), limit, (event) =>
    encodeCursor({
      signature: options.signature || '',
      occurredAt: event.occurredAt,
      eventId: event.id
    })
  );
}
