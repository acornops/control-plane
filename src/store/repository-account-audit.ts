import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { sanitizeAuditMetadata } from './repository-audit-events.js';

export interface AccountAuditEventInput {
  userId?: string | null;
  category: 'security' | 'auth';
  eventType: string;
  operation: 'read' | 'write';
  actorType?: 'user' | 'system' | 'external_integration';
  actorUserId?: string | null;
  actorTokenId?: string | null;
  objectType: string;
  objectId?: string | null;
  objectName?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function insertAccountAuditEvent(input: AccountAuditEventInput): Promise<void> {
  const actorType = input.actorType || (input.actorUserId ? 'user' : 'system');
  await db.query(
    `INSERT INTO account_audit_events (
       id, user_id, category, event_type, operation, actor_type, actor_user_id, actor_token_id,
       object_type, object_id, object_name, summary, metadata, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())`,
    [
      randomUUID(),
      input.userId || null,
      input.category,
      input.eventType,
      input.operation,
      actorType,
      actorType === 'user' ? input.actorUserId || null : null,
      actorType === 'external_integration' ? input.actorTokenId || null : null,
      input.objectType,
      input.objectId || null,
      input.objectName || null,
      input.summary,
      JSON.stringify(sanitizeAuditMetadata(input.metadata))
    ]
  );
}
