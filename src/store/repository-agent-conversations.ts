import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import type { AgentDefinition, RunPrincipalRef } from '../types/agents.js';
import type { CompiledAgentChatAccessScope } from '../types/agent-chat.js';
import type { ChatSession, Message, Run } from '../types/domain.js';
import {
  type CreateRunFromMessageResult,
  type MessageRow,
  type RunRow,
  type SessionRow,
  mapMessage,
  mapRun,
  mapSession
} from './repository-mappers.js';
import type { RunRequestProvenance } from './repository-run-provenance.js';
import { getRunEvents } from './repository-run-events.js';
import { withTransaction } from './repository-transaction.js';
import {
  type ConversationDeletionResult,
  conversationExpiry,
  deleteConversationSession,
  findConversationRunByClientMessageId
} from './repository-conversation-runtime.js';

const agentSessionSelect = `
  SELECT s.*, u.id AS created_by_user_id, u.display_name AS created_by_display_name,
         latest_run.llm_provider AS last_llm_provider,
         latest_run.llm_model AS last_llm_model,
         latest_run.llm_reasoning_effort AS last_llm_reasoning_effort
  FROM sessions s
  LEFT JOIN users u ON u.id = s.created_by
  LEFT JOIN LATERAL (
    SELECT r.llm_provider, r.llm_model, r.llm_reasoning_effort
    FROM runs r
    WHERE r.session_id = s.id
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT 1
  ) latest_run ON TRUE
`;
const agentConversationRunSelect = 'SELECT r.* FROM runs r';

export class AgentConversationStateConflictError extends Error {
  constructor() {
    super('The Agent conversation or Agent definition changed before the run was created. Retry the message.');
    this.name = 'AgentConversationStateConflictError';
  }
}

export async function addAgentConversationSession(input: {
  workspaceId: string;
  agentId: string;
  createdBy: string;
  title: string;
  preferredAccessMode: Run['toolAccessMode'];
}): Promise<ChatSession> {
  const id = randomUUID();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = conversationExpiry(nowDate);
  const result = await db.query(
    `INSERT INTO sessions (
       id,workspace_id,created_by,origin,title,status,created_at,updated_at,
       last_message_at,expires_at,conversation_kind,agent_id,preferred_access_mode
     ) VALUES ($1,$2,$3,'manual',$4,'open',$5,$5,$5,$6,'agent_chat',$7,$8)
     RETURNING *`,
    [id, input.workspaceId, input.createdBy, input.title, now, expiresAt, input.agentId, input.preferredAccessMode]
  );
  return mapSession(result.rows[0] as SessionRow);
}

export async function listAgentConversationSessions(
  workspaceId: string,
  agentId: string
): Promise<ChatSession[]> {
  const result = await db.query(
    `${agentSessionSelect}
     WHERE s.workspace_id=$1
       AND s.agent_id=$2
       AND s.conversation_kind='agent_chat'
       AND s.deleted_at IS NULL
       AND s.expires_at>NOW()
     ORDER BY s.last_message_at DESC,s.id DESC`,
    [workspaceId, agentId]
  );
  return result.rows.map((row) => mapSession(row as SessionRow));
}

export async function setAgentConversationAccessMode(
  sessionId: string,
  accessMode: Run['toolAccessMode']
): Promise<ChatSession | null> {
  const result = await db.query(
    `WITH updated AS (
       UPDATE sessions
       SET preferred_access_mode=$2,updated_at=NOW()
       WHERE id=$1 AND conversation_kind='agent_chat' AND deleted_at IS NULL AND expires_at>NOW()
       RETURNING *
     )
     SELECT updated.*
     FROM updated`,
    [sessionId, accessMode]
  );
  return result.rowCount ? mapSession(result.rows[0] as SessionRow) : null;
}

export async function listAgentConversationMessages(sessionId: string): Promise<Message[]> {
  const result = await db.query(
    `SELECT m.*,u.id AS created_by_user_id,u.display_name AS created_by_display_name
     FROM messages m
     LEFT JOIN users u ON u.id=m.created_by
     WHERE m.session_id=$1 AND m.kind IN ('user','assistant_final')
     ORDER BY m.created_at ASC,m.id ASC`,
    [sessionId]
  );
  return result.rows.map((row) => mapMessage(row as MessageRow));
}

export async function createAgentConversationRunFromUserMessage(params: {
  sessionId: string;
  workspaceId: string;
  agent: AgentDefinition;
  content: string;
  toolAccessMode: Run['toolAccessMode'];
  compiledAccessScope: CompiledAgentChatAccessScope;
  llmProvider: Run['llmProvider'];
  llmModel: string;
  llmReasoningSummaryMode: Run['llmReasoningSummaryMode'];
  llmReasoningEffort: Run['llmReasoningEffort'];
  clientMessageId?: string;
  principal: RunPrincipalRef;
  requestProvenance?: RunRequestProvenance;
  createdBy: string;
}): Promise<CreateRunFromMessageResult> {
  return withTransaction(async (client) => {
    const agentResult = await client.query<{
      agent_updated_at: Date;
      agent_status: AgentDefinition['status'];
      agent_readiness_status: AgentDefinition['readiness']['status'];
    }>(
      `SELECT a.updated_at AS agent_updated_at,a.status AS agent_status,
              a.readiness_status AS agent_readiness_status
       FROM agent_definitions a
       WHERE a.workspace_id=$1 AND a.id=$2
       FOR SHARE`,
      [params.workspaceId, params.agent.id]
    );
    if (!agentResult.rowCount) throw new AgentConversationStateConflictError();
    const conversationResult = await client.query(
      `SELECT 1 FROM sessions
       WHERE id=$1 AND workspace_id=$2 AND agent_id=$3
         AND conversation_kind='agent_chat' AND created_by=$4
         AND preferred_access_mode=$5 AND deleted_at IS NULL AND expires_at>NOW()
       FOR UPDATE`,
      [params.sessionId, params.workspaceId, params.agent.id, params.createdBy, params.toolAccessMode]
    );
    if (!conversationResult.rowCount) throw new AgentConversationStateConflictError();

    const existing = await findConversationRunByClientMessageId(
      client,
      params.sessionId,
      params.clientMessageId,
      agentConversationRunSelect
    );
    if (existing) return existing;

    const locked = agentResult.rows[0];
    if (locked.agent_updated_at.toISOString() !== params.agent.updatedAt
      || locked.agent_status !== 'active'
      || locked.agent_readiness_status !== 'ready') {
      throw new AgentConversationStateConflictError();
    }

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = conversationExpiry(nowDate);
    const messageId = randomUUID();
    const runId = randomUUID();
    const messageResult = await client.query(
      `INSERT INTO messages (
         id,session_id,run_id,role,kind,content,metadata,created_by,client_message_id,created_at
       ) VALUES ($1,$2,$3,'user','user',$4,NULL,$5,$6,$7)
       ON CONFLICT (session_id,client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [messageId, params.sessionId, runId, params.content, params.createdBy,
       params.clientMessageId || null, now]
    );
    if (!messageResult.rowCount && params.clientMessageId) {
      const concurrent = await findConversationRunByClientMessageId(
        client,
        params.sessionId,
        params.clientMessageId,
        agentConversationRunSelect
      );
      if (concurrent) return concurrent;
      throw new Error('Agent conversation idempotency record is incomplete');
    }
    const runResult = await client.query(
      `INSERT INTO runs (
         id,workspace_id,session_id,message_id,conversation_kind,
         agent_id,agent_snapshot,compiled_access_scope,
         llm_provider,llm_model,llm_reasoning_summary_mode,llm_reasoning_effort,
         tool_access_mode,status,requested_at,principal,assistant_references,
         request_actor_type,request_external_integration_link_id,request_external_integration_client_id
       ) VALUES (
         $1,$2,$3,$4,'agent_chat',$5,$6::jsonb,$7::jsonb,
         $8,$9,$10,$11,$12,'queued',$13,$14::jsonb,'[]'::jsonb,$15,$16,$17
       ) RETURNING *`,
      [runId, params.workspaceId, params.sessionId, messageId, params.agent.id,
       JSON.stringify(params.agent), JSON.stringify(params.compiledAccessScope), params.llmProvider,
       params.llmModel, params.llmReasoningSummaryMode, params.llmReasoningEffort,
       params.toolAccessMode, now, JSON.stringify(params.principal),
       params.requestProvenance?.actorType || 'user',
       params.requestProvenance?.externalIntegrationLinkId || null,
       params.requestProvenance?.externalIntegrationClientId || null]
    );
    await client.query(
      `UPDATE sessions
       SET updated_at=$2,last_message_at=$2,expires_at=$3,launched_at=COALESCE(launched_at,$2)
       WHERE id=$1 AND conversation_kind='agent_chat'`,
      [params.sessionId, now, expiresAt]
    );
    return {
      message: mapMessage(messageResult.rows[0] as MessageRow),
      run: mapRun(runResult.rows[0] as RunRow),
      idempotent: false
    };
  });
}

export async function listAgentConversationRuns(
  sessionId: string
): Promise<Array<Run & { events: import('../types/domain.js').RunEvent[] }>> {
  const result = await db.query(
    `${agentConversationRunSelect}
     WHERE r.session_id=$1
     ORDER BY r.requested_at DESC,r.id DESC`,
    [sessionId]
  );
  const runs = result.rows.map((row) => mapRun(row as RunRow));
  return Promise.all(runs.map(async (run) => ({ ...run, events: await getRunEvents(run.id) })));
}

export async function deleteAgentConversationSession(
  sessionId: string
): Promise<ConversationDeletionResult> {
  return deleteConversationSession({ sessionId, conversationKind: 'agent_chat' });
}
