import type { PoolClient } from 'pg';
import { config } from '../config.js';
import type { CreateRunFromMessageResult, MessageRow, RunRow } from './repository-mappers.js';
import { mapMessage, mapRun } from './repository-mappers.js';
import type { ChatSession } from '../types/domain.js';
import { withTransaction } from './repository-transaction.js';

export const conversationRunSelect = `
  SELECT r.*, t.target_type
  FROM runs r
  LEFT JOIN targets t ON t.id = r.target_id
`;

export function conversationExpiry(baseDate: Date = new Date()): string {
  const expiresAt = new Date(baseDate);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + config.CONVERSATION_RETENTION_DAYS);
  return expiresAt.toISOString();
}

export async function findConversationRunByClientMessageId(
  queryable: Pick<PoolClient, 'query'>,
  sessionId: string,
  clientMessageId?: string,
  runSelect = conversationRunSelect
): Promise<CreateRunFromMessageResult | null> {
  if (!clientMessageId) return null;
  const messageResult = await queryable.query(
    `SELECT * FROM messages
     WHERE session_id=$1 AND client_message_id=$2 AND kind='user'
     LIMIT 1`,
    [sessionId, clientMessageId]
  );
  if (!messageResult.rowCount) return null;
  const message = mapMessage(messageResult.rows[0] as MessageRow);
  if (!message.runId) return null;
  const runResult = await queryable.query(
    `${runSelect} WHERE r.id=$1 LIMIT 1`,
    [message.runId]
  );
  if (!runResult.rowCount) return null;
  return { message, run: mapRun(runResult.rows[0] as RunRow), idempotent: true };
}

export type ConversationDeletionResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'active_runs'; runIds: string[] };

export async function deleteConversationSession(input: {
  sessionId: string;
  conversationKind: ChatSession['conversationKind'];
  clearTargetAutoTriageLink?: boolean;
}): Promise<ConversationDeletionResult> {
  return withTransaction(async (client) => {
    const session = await client.query(
      `SELECT id FROM sessions
       WHERE id=$1 AND conversation_kind=$2 AND deleted_at IS NULL AND expires_at>NOW()
       FOR UPDATE`,
      [input.sessionId, input.conversationKind]
    );
    if (!session.rowCount) return { status: 'not_found' };
    const activeRuns = await client.query<{ id: string }>(
      `SELECT id FROM runs
       WHERE session_id=$1 AND conversation_kind=$2
         AND status IN ('queued','dispatching','running','waiting_for_approval','cancelling')
       ORDER BY requested_at,id`,
      [input.sessionId, input.conversationKind]
    );
    if (activeRuns.rowCount) {
      return { status: 'active_runs', runIds: activeRuns.rows.map((row) => row.id) };
    }
    await client.query(
      `UPDATE sessions
       SET status='deleted',deleted_at=NOW(),updated_at=NOW()
       WHERE id=$1`,
      [input.sessionId]
    );
    if (input.clearTargetAutoTriageLink) {
      await client.query(
        `UPDATE target_auto_triage_jobs
         SET session_id=NULL,updated_at=NOW()
         WHERE session_id=$1`,
        [input.sessionId]
      );
    }
    return { status: 'deleted' };
  });
}
