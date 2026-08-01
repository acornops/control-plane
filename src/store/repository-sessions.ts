import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { ChatSession, Message, Run } from '../types/domain.js';
import type { AssistantReference } from '../types/assistant-references.js';
import type { RunPrincipalRef } from '../types/agents.js';
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
import { sessionSelect } from './repository-session-select.js';
import {
  conversationExpiry,
  conversationRunSelect,
  deleteConversationSession,
  findConversationRunByClientMessageId
} from './repository-conversation-runtime.js';

export {
  addRun,
  appendRunEvents,
  getLatestRunEventSeq,
  getRun,
  getRunEvents,
  updateRun
} from './repository-runs.js';

export async function addSession(
    workspaceId: string,
    targetId: string,
    createdBy: string,
    title: string,
    options?: {
      origin?: ChatSession['origin'];
      linkedIssueId?: string;
      linkedIssueLifecycleVersion?: number;
      autoTriageWriteMode?: import('../types/auto-triage.js').AutoTriageWriteMode;
      autoTriageEffectiveToolMode?: Run['toolAccessMode'];
      autoTriageConfirmationRequired?: boolean;
      transactionClient?: PoolClient;
    }
  ): Promise<ChatSession> {
    const id = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = conversationExpiry(nowDate);
    const result = await (options?.transactionClient || db).query(
      `WITH inserted AS (
         INSERT INTO sessions (
           id, workspace_id, target_id, created_by, title, status, created_at, updated_at,
           last_message_at, expires_at, origin, linked_issue_id, linked_issue_lifecycle_version,
           auto_triage_write_mode, auto_triage_effective_tool_mode, auto_triage_confirmation_required
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *
       )
       SELECT inserted.*, t.target_type, u.id AS created_by_user_id, u.display_name AS created_by_display_name,
              linked_issue.severity AS linked_issue_severity,
              linked_issue.scope_kind AS linked_issue_scope_kind,
              linked_issue.scope_name AS linked_issue_scope_name,
              linked_issue.object_kind AS linked_issue_object_kind,
              linked_issue.object_name AS linked_issue_object_name
       FROM inserted
       JOIN targets t ON t.id = inserted.target_id
       LEFT JOIN users u ON u.id = inserted.created_by
       LEFT JOIN target_issues linked_issue ON linked_issue.id = inserted.linked_issue_id`,
      [
        id, workspaceId, targetId, createdBy, title, 'open', now, now, now, expiresAt,
        options?.origin || 'manual',
        options?.linkedIssueId || null,
        options?.linkedIssueLifecycleVersion || null,
        options?.autoTriageWriteMode || null,
        options?.autoTriageEffectiveToolMode || null,
        options?.autoTriageConfirmationRequired ?? null
      ]
    );
    return mapSession(result.rows[0]);
  }

export async function getAutomaticSessionForIssueLifecycle(
  issueId: string,
  lifecycleVersion: number,
  queryable: Pick<typeof db, 'query'> = db
): Promise<ChatSession | null> {
  const result = await queryable.query(
    `${sessionSelect}
     WHERE s.origin = 'auto_triage'
       AND s.linked_issue_id = $1
       AND s.linked_issue_lifecycle_version = $2
     LIMIT 1`,
    [issueId, lifecycleVersion]
  );
  return result.rowCount ? mapSession(result.rows[0] as SessionRow) : null;
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
export async function deleteSession(sessionId: string) {
    return deleteConversationSession({
      sessionId,
      conversationKind: 'target_chat',
      clearTargetAutoTriageLink: true
    });
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
    clientMessageId?: string,
    createdBy?: string,
    metadata?: Record<string, unknown>
  ): Promise<Message> {
    const id = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = conversationExpiry(nowDate);
    const result = await db.query(
      `WITH inserted AS (
         INSERT INTO messages (id, session_id, run_id, role, kind, content, metadata, created_by, client_message_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         RETURNING *
       ), updated_session AS (
         UPDATE sessions
         SET updated_at = $10,
             last_message_at = $10,
             expires_at = $11
         WHERE id = $2
       )
       SELECT * FROM inserted`,
      [
        id, sessionId, runId || null, role, kind, content,
        JSON.stringify(metadata || null), createdBy || null, clientMessageId || null, now, expiresAt
      ]
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
      `SELECT m.*, u.id AS created_by_user_id, u.display_name AS created_by_display_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.session_id = $1
         AND m.kind IN ('user', 'assistant_final')
         AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
         AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::text))
       ORDER BY m.created_at DESC, m.id DESC
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
    return findConversationRunByClientMessageId(db, sessionId, clientMessageId);
  }
export async function createRunFromUserMessage(params: {
    sessionId: string;
    workspaceId: string;
    targetId: string;
    targetType: NonNullable<Run['targetType']>;
    content: string;
    toolAccessMode: Run['toolAccessMode'];
    llmProvider: Run['llmProvider'];
    llmModel: string;
    llmReasoningSummaryMode: Run['llmReasoningSummaryMode'];
    llmReasoningEffort: Run['llmReasoningEffort'];
    clientMessageId?: string;
    assistantReferences: AssistantReference[];
    principal: RunPrincipalRef;
    requestProvenance?: RunRequestProvenance;
    messageCreatedBy?: string;
    messageMetadata?: Record<string, unknown>;
    confirmationRequiredForWriteOverride?: boolean;
    transactionClient?: PoolClient;
  }): Promise<CreateRunFromMessageResult> {
    const create = async (client: PoolClient): Promise<CreateRunFromMessageResult> => {
      if (params.clientMessageId) {
        const existing = await findConversationRunByClientMessageId(client, params.sessionId, params.clientMessageId);
        if (existing) {
          return existing;
        }
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = conversationExpiry(nowDate);
      const messageId = randomUUID();
      const runId = randomUUID();

      let insertedMessageResult;
      try {
        insertedMessageResult = await client.query(
          `INSERT INTO messages (id, session_id, run_id, role, kind, content, metadata, created_by, client_message_id, created_at)
           VALUES ($1,$2,$3,'user','user',$4,$5::jsonb,$6,$7,$8)
           RETURNING *`,
          [
            messageId,
            params.sessionId,
            runId,
            params.content,
            JSON.stringify({
              ...(params.messageMetadata || {}),
              ...(params.assistantReferences.length > 0
                ? {
                    assistantReferences: params.assistantReferences.map((reference) => ({
                      kind: reference.kind,
                      id: reference.id,
                      label: reference.label,
                      ...(reference.description ? { description: reference.description } : {}),
                      source: reference.source,
                      ...(reference.kind === 'tool' ? { capability: reference.capability } : {})
                    }))
                  }
                : {})
            }),
            params.messageCreatedBy || null,
            params.clientMessageId || null,
            now
          ]
        );
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError?.code === '23505' && params.clientMessageId) {
          const existing = await findConversationRunByClientMessageId(client, params.sessionId, params.clientMessageId);
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
             error_code, error_message, usage, assistant_message, principal, assistant_references,
             request_actor_type,request_external_integration_link_id,request_external_integration_client_id,
             confirmation_required_for_write_override
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24)
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
          JSON.stringify(params.principal),
          JSON.stringify(params.assistantReferences),
          params.requestProvenance?.actorType || 'user',
          params.requestProvenance?.externalIntegrationLinkId || null,
          params.requestProvenance?.externalIntegrationClientId || null,
          params.confirmationRequiredForWriteOverride ?? null
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
    };
    return params.transactionClient
      ? create(params.transactionClient)
      : withTransaction(create);
  }

export async function upsertAssistantFinalMessage(sessionId: string, runId: string, content: string): Promise<Message> {
    return withTransaction(async (client) => {
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const expiresAt = conversationExpiry(nowDate);
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
