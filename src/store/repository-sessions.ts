import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { ChatSession, Message, Run } from '../types/domain.js';
import {
  CreateRunFromMessageResult,
  MessageRow,
  RunRow,
  SessionListPage,
  SessionRow,
  mapMessage,
  mapRun,
  mapSession
} from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { createRunSkillSnapshotInTransaction } from './repository-run-skill-snapshots.js';
import { RunRequestProvenance } from './repository-run-provenance.js';
import { scheduleTargetInsightsCheckpointJobForSessionActivity } from './repository-target-insights-checkpoints.js';

const runSelect = `
  SELECT r.*, t.target_type
  FROM runs r
  JOIN targets t ON t.id = r.target_id
`;

const sessionSelect = `
  SELECT s.*, t.target_type, u.id AS created_by_user_id, u.display_name AS created_by_display_name,
         latest_run.llm_provider AS last_llm_provider,
         latest_run.llm_model AS last_llm_model,
         latest_run.llm_reasoning_effort AS last_llm_reasoning_effort
  FROM sessions s
  JOIN targets t ON t.id = s.target_id
  LEFT JOIN users u ON u.id = s.created_by
  LEFT JOIN LATERAL (
    SELECT r.llm_provider, r.llm_model, r.llm_reasoning_effort
    FROM runs r
    WHERE r.session_id = s.id
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT 1
  ) latest_run ON TRUE
`;

function calculateSessionExpiry(baseDate: Date = new Date()): string {
  const expiresAt = new Date(baseDate);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + config.CONVERSATION_RETENTION_DAYS);
  return expiresAt.toISOString();
}

export async function addSession(workspaceId: string, targetId: string, createdBy: string, title: string): Promise<ChatSession> {
    const id = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = calculateSessionExpiry(nowDate);
    const result = await db.query(
      `WITH inserted AS (
         INSERT INTO sessions (id, workspace_id, target_id, created_by, title, status, created_at, updated_at, last_message_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *
       )
       SELECT inserted.*, t.target_type, u.id AS created_by_user_id, u.display_name AS created_by_display_name
       FROM inserted
       JOIN targets t ON t.id = inserted.target_id
       LEFT JOIN users u ON u.id = inserted.created_by`,
      [id, workspaceId, targetId, createdBy, title, 'open', now, now, now, expiresAt]
    );
    return mapSession(result.rows[0]);
  }
export async function listSessionsByTarget(
    workspaceId: string,
    targetId: string,
    options?: {
      limit?: number;
      cursor?: { lastMessageAt: string; sessionId: string } | null;
      q?: string;
      status?: ChatSession['status'];
      signature?: string;
    }
  ): Promise<SessionListPage> {
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const params: Array<string | number> = [workspaceId, targetId, limit + 1];
    const clauses = [
      's.workspace_id = $1',
      's.target_id = $2',
      's.deleted_at IS NULL',
      's.expires_at > NOW()'
    ];
    if (options?.status) {
      params.push(options.status);
      clauses.push(`s.status = $${params.length}`);
    }
    if (options?.q) {
      params.push(`%${options.q}%`);
      clauses.push(`LOWER(s.title) LIKE $${params.length}`);
    }
    if (options?.cursor) {
      params.push(options.cursor.lastMessageAt, options.cursor.sessionId);
      clauses.push(`(s.last_message_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
    }

    const result = await db.query(
      `${sessionSelect}
       WHERE ${clauses.join(' AND ')}
       ORDER BY s.last_message_at DESC, s.id DESC
       LIMIT $3`,
      params
    );
    const rows = result.rows.map((row) => mapSession(row as SessionRow));
    return pageWithCursor(rows, limit, (session) =>
      encodeCursor({
        signature: options?.signature || '',
        lastMessageAt: session.lastMessageAt,
        sessionId: session.id
      })
    );
  }

export async function getSession(sessionId: string, includeDeleted = false): Promise<ChatSession | null> {
    const result = await db.query(
      `${sessionSelect}
       WHERE s.id = $1
         AND ($2::boolean = true OR (s.deleted_at IS NULL AND s.expires_at > NOW()))`,
      [sessionId, includeDeleted]
    );
    if (!result.rowCount) return null;
    return mapSession(result.rows[0]);
  }
export async function deleteSession(sessionId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE sessions
       SET status = 'deleted',
           deleted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND deleted_at IS NULL`,
      [sessionId]
    );
    return (result.rowCount ?? 0) > 0;
  }
export async function purgeExpiredOrDeletedSessions(limit = 500): Promise<number> {
    const result = await db.query(
      `WITH candidate AS (
         SELECT id
         FROM sessions
         WHERE deleted_at IS NOT NULL OR expires_at <= NOW()
         ORDER BY COALESCE(deleted_at, expires_at) ASC
         LIMIT $1
       )
       DELETE FROM sessions s
       USING candidate c
       WHERE s.id = c.id`,
      [Math.max(1, Math.min(5000, limit))]
    );
    return result.rowCount ?? 0;
  }
export async function addMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    runId?: string,
    kind: Message['kind'] = role === 'assistant' ? 'assistant_final' : 'user',
    clientMessageId?: string
  ): Promise<Message> {
    const id = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = calculateSessionExpiry(nowDate);
    const result = await db.query(
      `WITH inserted AS (
         INSERT INTO messages (id, session_id, run_id, role, kind, content, metadata, client_message_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING *
       ), updated_session AS (
         UPDATE sessions
         SET updated_at = $9,
             last_message_at = $9,
             expires_at = $10
         WHERE id = $2
       )
       SELECT * FROM inserted`,
      [id, sessionId, runId || null, role, kind, content, JSON.stringify(null), clientMessageId || null, now, expiresAt]
    );
    await scheduleTargetInsightsCheckpointJobForSessionActivity(sessionId, now);
    return mapMessage(result.rows[0]);
  }
export async function listMessages(
    sessionId: string,
    options?: { cursor?: { createdAt: string; messageId: string } | null; before?: string; limit?: number; signature?: string }
  ): Promise<PagedResult<Message>> {
    const limit = Math.max(1, Math.min(200, options?.limit ?? 100));
    const before = options?.before || null;
    const cursor = options?.cursor || null;
    const result = await db.query(
      `SELECT *
       FROM messages
       WHERE session_id = $1
         AND kind IN ('user', 'assistant_final')
         AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::text))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [sessionId, before, cursor?.createdAt || null, cursor?.messageId || null, limit + 1]
    );
    const rows = result.rows.map((row) => mapMessage(row as MessageRow));
    const page = pageWithCursor(rows, limit, (message) =>
      encodeCursor({
        signature: options?.signature || '',
        createdAt: message.createdAt,
        messageId: message.id
      })
    );
    return {
      items: page.items.reverse(),
      nextCursor: page.nextCursor
    };
  }
export async function updateMessageRunId(messageId: string, runId: string): Promise<void> {
    await db.query('UPDATE messages SET run_id = $2 WHERE id = $1', [messageId, runId]);
  }
export async function findRunByClientMessageId(sessionId: string, clientMessageId: string): Promise<CreateRunFromMessageResult | null> {
    const messageResult = await db.query(
      `SELECT *
       FROM messages
       WHERE session_id = $1
         AND client_message_id = $2
         AND kind = 'user'
       LIMIT 1`,
      [sessionId, clientMessageId]
    );
    if (!messageResult.rowCount) {
      return null;
    }
    const message = mapMessage(messageResult.rows[0] as MessageRow);
    if (!message.runId) {
      return null;
    }
    const runResult = await db.query(`${runSelect} WHERE r.id = $1 LIMIT 1`, [message.runId]);
    if (!runResult.rowCount) {
      return null;
    }
    return {
      message,
      run: mapRun(runResult.rows[0] as RunRow),
      idempotent: true
    };
  }
export async function createRunFromUserMessage(params: {
    sessionId: string;
    workspaceId: string;
    targetId: string;
    targetType: Run['targetType'];
    content: string;
    toolAccessMode: Run['toolAccessMode'];
    llmProvider: Run['llmProvider'];
    llmModel: string;
    llmReasoningSummaryMode: Run['llmReasoningSummaryMode'];
    llmReasoningEffort: Run['llmReasoningEffort'];
    clientMessageId?: string;
    requestProvenance: RunRequestProvenance;
  }): Promise<CreateRunFromMessageResult> {
    return withTransaction(async (client) => {
      const findExistingByClientMessageId = async (): Promise<CreateRunFromMessageResult | null> => {
        if (!params.clientMessageId) return null;
        const existingMessageResult = await client.query(
          `SELECT * FROM messages
           WHERE session_id = $1
             AND client_message_id = $2
             AND kind = 'user'
           LIMIT 1`,
          [params.sessionId, params.clientMessageId]
        );
        if (!existingMessageResult.rowCount) {
          return null;
        }
        const existingMessage = mapMessage(existingMessageResult.rows[0] as MessageRow);
        if (!existingMessage.runId) {
          return null;
        }
        const existingRunResult = await client.query(`${runSelect} WHERE r.id = $1 LIMIT 1`, [existingMessage.runId]);
        if (!existingRunResult.rowCount) {
          return null;
        }
        return {
          message: existingMessage,
          run: mapRun(existingRunResult.rows[0] as RunRow),
          idempotent: true
        };
      };

      if (params.clientMessageId) {
        const existing = await findExistingByClientMessageId();
        if (existing) {
          return existing;
        }
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = calculateSessionExpiry(nowDate);
      const messageId = randomUUID();
      const runId = randomUUID();

      let insertedMessageResult;
      try {
        insertedMessageResult = await client.query(
          `INSERT INTO messages (id, session_id, run_id, role, kind, content, metadata, client_message_id, created_at)
           VALUES ($1, $2, $3, 'user', 'user', $4, $5::jsonb, $6, $7)
           RETURNING *`,
          [messageId, params.sessionId, runId, params.content, JSON.stringify(null), params.clientMessageId || null, now]
        );
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError?.code === '23505' && params.clientMessageId) {
          const existing = await findExistingByClientMessageId();
          if (existing) {
            return existing;
          }
        }
        throw error;
      }

      const insertedRunResult = await client.query(
        `WITH inserted AS (
           INSERT INTO runs (
             id, workspace_id, target_id, session_id, message_id,
             llm_provider, llm_model, llm_reasoning_summary_mode, llm_reasoning_effort,
             tool_access_mode, status, requested_at, started_at, ended_at,
             error_code, error_message, usage, assistant_message,
             request_actor_type, request_external_integration_link_id,
             request_external_integration_client_id
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,
             $19,$20,$21
           )
           RETURNING *
         )
         SELECT inserted.*, t.target_type
         FROM inserted
         JOIN targets t ON t.id = inserted.target_id`,
        [
          runId,
          params.workspaceId,
          params.targetId,
          params.sessionId,
          messageId,
          params.llmProvider,
          params.llmModel,
          params.llmReasoningSummaryMode,
          params.llmReasoningEffort,
          params.toolAccessMode,
          'queued',
          now,
          null,
          null,
          null,
          null,
          JSON.stringify(null),
          JSON.stringify(null),
          params.requestProvenance.actorType,
          params.requestProvenance.externalIntegrationLinkId || null,
          params.requestProvenance.externalIntegrationClientId || null
        ]
      );

      await createRunSkillSnapshotInTransaction(client, {
        runId,
        workspaceId: params.workspaceId,
        targetId: params.targetId,
        targetType: params.targetType
      });

      await client.query(
        `UPDATE sessions
         SET updated_at = $2,
             last_message_at = $2,
             expires_at = $3
         WHERE id = $1`,
        [params.sessionId, now, expiresAt]
      );
      await scheduleTargetInsightsCheckpointJobForSessionActivity(params.sessionId, now, client);

      return {
        message: mapMessage(insertedMessageResult.rows[0] as MessageRow),
        run: mapRun(insertedRunResult.rows[0] as RunRow),
        idempotent: false
      };
    });
  }

export async function upsertAssistantFinalMessage(sessionId: string, runId: string, content: string): Promise<Message> {
    return withTransaction(async (client) => {
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = calculateSessionExpiry(nowDate);
      const existingResult = await client.query(
        `SELECT *
         FROM messages
         WHERE run_id = $1
           AND kind = 'assistant_final'
         ORDER BY created_at DESC, id DESC
         FOR UPDATE`,
        [runId]
      );

      let messageRow: MessageRow;
      if (existingResult.rowCount && existingResult.rowCount > 0) {
        const existingRows = existingResult.rows as MessageRow[];
        const primary = existingRows[0];
        const duplicateIds = existingRows.slice(1).map((row) => row.id);
        if (duplicateIds.length > 0) {
          await client.query('DELETE FROM messages WHERE id = ANY($1::text[])', [duplicateIds]);
        }
        const updated = await client.query(
          `UPDATE messages
           SET content = $2
           WHERE id = $1
           RETURNING *`,
          [primary.id, content]
        );
        messageRow = updated.rows[0] as MessageRow;
      } else {
        const inserted = await client.query(
          `INSERT INTO messages (id, session_id, run_id, role, kind, content, metadata, client_message_id, created_at)
           VALUES ($1, $2, $3, 'assistant', 'assistant_final', $4, $5::jsonb, NULL, $6)
           RETURNING *`,
          [randomUUID(), sessionId, runId, content, JSON.stringify(null), now]
        );
        messageRow = inserted.rows[0] as MessageRow;
      }

      await client.query(
        `UPDATE sessions
         SET updated_at = $2,
             last_message_at = $2,
             expires_at = $3
         WHERE id = $1`,
        [sessionId, now, expiresAt]
      );
      await scheduleTargetInsightsCheckpointJobForSessionActivity(sessionId, now, client);
      return mapMessage(messageRow);
    });
  }
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
        run.id,
        run.workspaceId,
        run.targetId,
        run.sessionId,
        run.messageId,
        run.llmProvider,
        run.llmModel,
        run.llmReasoningSummaryMode,
        run.llmReasoningEffort,
        run.toolAccessMode,
        run.status,
        run.requestedAt,
        run.startedAt || null,
        run.endedAt || null,
        run.errorCode || null,
        run.errorMessage || null,
        JSON.stringify(run.usage || null),
        JSON.stringify(run.assistantMessage || null)
      ]
    );
    return mapRun(result.rows[0]);
  }
export async function getRun(runId: string): Promise<Run | null> {
    const result = await db.query(`${runSelect} WHERE r.id = $1`, [runId]);
    if (!result.rowCount) return null;
    return mapRun(result.rows[0]);
  }
export async function updateRun(runId: string, patch: Partial<Run>): Promise<Run | null> {
    const current = await getRun(runId);
    if (!current) return null;

    const next: Run = {
      ...current,
      ...patch
    };

    const result = await db.query(
      `WITH updated AS (
         UPDATE runs
         SET status = $2,
             started_at = $3,
             ended_at = $4,
             error_code = $5,
             error_message = $6,
             usage = $7::jsonb,
             assistant_message = $8::jsonb
         WHERE id = $1
         RETURNING *
       )
       SELECT updated.*, t.target_type
       FROM updated
       JOIN targets t ON t.id = updated.target_id`,
      [
        runId,
        next.status,
        next.startedAt || null,
        next.endedAt || null,
        next.errorCode || null,
        next.errorMessage || null,
        JSON.stringify(next.usage || null),
        JSON.stringify(next.assistantMessage || null)
      ]
    );
    return mapRun(result.rows[0]);
  }
