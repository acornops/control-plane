import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import {
  WorkspaceAuditCategory,
  WorkspaceAuditEvent,
  WorkspaceAuditEventInput,
  WorkspaceAuditLoggingMode
} from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { toIso } from './repository-mappers.js';

interface Queryable {
  query: PoolClient['query'];
}

interface WorkspaceAuditEventRow {
  id: string;
  workspace_id: string;
  category: WorkspaceAuditCategory;
  event_type: string;
  operation: 'read' | 'write';
  actor_type: 'user' | 'system' | 'admin_token';
  actor_user_id: string | null;
  actor_token_id: string | null;
  actor_email: string | null;
  actor_display_name: string | null;
  object_type: string;
  object_id: string | null;
  object_name: string | null;
  summary: string;
  metadata: Record<string, unknown> | string | null;
  occurred_at: Date | string;
}

const REDACTED = '[redacted]';
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_STRING_LENGTH = 1024;

function isSensitiveAuditMetadataKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/g, '').toLowerCase();
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('authorization') ||
    normalized.includes('cookie') ||
    normalized.includes('header') ||
    normalized.includes('content') ||
    normalized.includes('argument') ||
    normalized === 'log' ||
    normalized === 'logs' ||
    normalized === 'podlog' ||
    normalized === 'podlogs' ||
    normalized === 'logcontent' ||
    normalized === 'podlogcontent'
  );
}

function sanitizeAuditMetadataValue(value: unknown, key = '', depth = 0): unknown {
  if (isSensitiveAuditMetadataKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_METADATA_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditMetadataValue(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeAuditMetadataValue(entryValue, entryKey, depth + 1)
      ])
    );
  }
  return String(value);
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return sanitizeAuditMetadataValue(metadata) as Record<string, unknown>;
}

function mapAuditEvent(row: WorkspaceAuditEventRow): WorkspaceAuditEvent {
  const metadata = typeof row.metadata === 'string'
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : row.metadata || {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    eventType: row.event_type,
    operation: row.operation,
    actor: {
      type: row.actor_type,
      ...(row.actor_user_id ? { userId: row.actor_user_id } : {}),
      ...(row.actor_token_id ? { tokenId: row.actor_token_id } : {}),
      ...(row.actor_email ? { email: row.actor_email } : {}),
      ...(row.actor_display_name ? { displayName: row.actor_display_name } : {})
    },
    object: {
      type: row.object_type,
      ...(row.object_id ? { id: row.object_id } : {}),
      ...(row.object_name ? { name: row.object_name } : {})
    },
    summary: row.summary,
    metadata,
    occurredAt: toIso(row.occurred_at)!
  };
}

export function shouldPersistWorkspaceAuditEvent(
  input: Pick<WorkspaceAuditEventInput, 'operation'>,
  mode: WorkspaceAuditLoggingMode
): boolean {
  if (mode === 'disabled') return false;
  if (mode === 'write_only') return input.operation === 'write';
  return true;
}

export async function insertWorkspaceAuditEvent(
  input: WorkspaceAuditEventInput,
  queryable: Queryable = db,
  loggingMode: WorkspaceAuditLoggingMode = config.WORKSPACE_AUDIT_LOGGING_MODE
): Promise<WorkspaceAuditEvent | null> {
  if (!shouldPersistWorkspaceAuditEvent(input, loggingMode)) {
    return null;
  }
  const actorType = input.actorType || (input.actorUserId ? 'user' : 'system');
  const result = await queryable.query(
    `INSERT INTO workspace_audit_events (
       id, workspace_id, category, event_type, operation, actor_type, actor_user_id, actor_token_id,
       object_type, object_id, object_name, summary, metadata, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())
     RETURNING
       workspace_audit_events.*,
       NULL::text AS actor_email,
       NULL::text AS actor_display_name`,
    [
      randomUUID(),
      input.workspaceId,
      input.category,
      input.eventType,
      input.operation,
      actorType,
      actorType === 'user' ? input.actorUserId || null : null,
      actorType === 'admin_token' ? input.actorTokenId || null : null,
      input.objectType,
      input.objectId || null,
      input.objectName || null,
      input.summary,
      JSON.stringify(sanitizeAuditMetadata(input.metadata))
    ]
  );
  return mapAuditEvent(result.rows[0] as WorkspaceAuditEventRow);
}

export async function purgeOldWorkspaceAuditEvents(
  retentionDays: number,
  limit = 1000,
  queryable: Queryable = db
): Promise<number> {
  const safeRetentionDays = Math.max(1, Math.floor(Number.isFinite(retentionDays) ? retentionDays : 1));
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number.isFinite(limit) ? limit : 1000)));
  const result = await queryable.query(
    `WITH deleted AS (
       DELETE FROM workspace_audit_events
       WHERE id IN (
         SELECT id
         FROM workspace_audit_events
         WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY occurred_at ASC, id ASC
         LIMIT $2
       )
       RETURNING 1
     )
     SELECT COUNT(*)::int AS deleted_count
     FROM deleted`,
    [safeRetentionDays, safeLimit]
  );
  return Number(result.rows[0]?.deleted_count ?? 0);
}

export async function listWorkspaceAuditEvents(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: { occurredAt: string; eventId: string } | null;
    category?: WorkspaceAuditCategory;
    eventType?: string;
    actorUserId?: string;
    objectType?: string;
    metadataTargetId?: string;
    from?: string;
    to?: string;
    signature?: string;
  } = {}
): Promise<PagedResult<WorkspaceAuditEvent>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [workspaceId, limit + 1];
  const clauses = ['e.workspace_id = $1'];
  if (options.category) {
    params.push(options.category);
    clauses.push(`e.category = $${params.length}`);
  }
  if (options.eventType) {
    params.push(options.eventType);
    clauses.push(`e.event_type = $${params.length}`);
  }
  if (options.actorUserId) {
    params.push(options.actorUserId);
    clauses.push(`e.actor_user_id = $${params.length}`);
  }
  if (options.objectType) {
    params.push(options.objectType);
    clauses.push(`e.object_type = $${params.length}`);
  }
  if (options.metadataTargetId) {
    params.push(options.metadataTargetId);
    clauses.push(`e.metadata->>'targetId' = $${params.length}`);
  }
  if (options.from) {
    params.push(options.from);
    clauses.push(`e.occurred_at >= $${params.length}::timestamptz`);
  }
  if (options.to) {
    params.push(options.to);
    clauses.push(`e.occurred_at <= $${params.length}::timestamptz`);
  }
  if (options.cursor) {
    params.push(options.cursor.occurredAt, options.cursor.eventId);
    clauses.push(`(e.occurred_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }

  const result = await db.query(
    `SELECT
       e.*,
       u.email AS actor_email,
       u.display_name AS actor_display_name
     FROM workspace_audit_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map((row) => mapAuditEvent(row as WorkspaceAuditEventRow)), limit, (event) =>
    encodeCursor({
      signature: options.signature || '',
      occurredAt: event.occurredAt,
      eventId: event.id
    })
  );
}
