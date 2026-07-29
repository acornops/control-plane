import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import type { RunRequestProvenance } from './repository-run-provenance.js';

export interface WorkflowSessionRecord {
  id: string;
  workflowId: string;
  workspaceId: string;
  workflowVersion: number;
  workflowSnapshot?: WorkflowDefinitionForAccess;
  createdBy: string;
  requestProvenance: RunRequestProvenance;
  compiledAccessScope: CompiledWorkflowAccessScope;
  conversationOrigin: 'workflow' | 'agent_chat';
  agentId?: string;
  accessMode: 'read_only' | 'read_write';
  agentChatReadScope?: CompiledWorkflowAccessScope;
  agentChatCapabilityCeiling?: CompiledWorkflowAccessScope;
  launchedAt?: string;
  launchResourceInputs: Record<string, string>;
  createdAt: string;
}

type Row = QueryResultRow;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapSession(row: Row): WorkflowSessionRecord {
  return {
    id: row.id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
    workflowVersion: row.workflow_version, createdBy: row.created_by,
    workflowSnapshot: row.workflow_snapshot || undefined,
    requestProvenance: {
      actorType: row.request_actor_type || 'user',
      ...(row.request_external_integration_link_id ? { externalIntegrationLinkId: row.request_external_integration_link_id } : {}),
      ...(row.request_external_integration_client_id ? { externalIntegrationClientId: row.request_external_integration_client_id } : {})
    },
    compiledAccessScope: row.compiled_access_scope,
    conversationOrigin: row.conversation_origin || 'workflow',
    agentId: row.agent_id || undefined,
    accessMode: row.access_mode || 'read_only',
    agentChatReadScope: row.agent_chat_read_scope || undefined,
    agentChatCapabilityCeiling: row.agent_chat_capability_ceiling || undefined,
    launchedAt: iso(row.launched_at),
    launchResourceInputs: row.launch_resource_inputs || {},
    createdAt: iso(row.created_at)!
  };
}

export async function createWorkflowSession(params: {
  workflow: WorkflowDefinitionForAccess;
  createdBy: string;
  compiledAccessScope: CompiledWorkflowAccessScope;
  requestProvenance?: RunRequestProvenance;
  sessionId?: string;
  conversationOrigin?: WorkflowSessionRecord['conversationOrigin'];
  agentId?: string;
  accessMode?: WorkflowSessionRecord['accessMode'];
  agentChatReadScope?: CompiledWorkflowAccessScope;
  agentChatCapabilityCeiling?: CompiledWorkflowAccessScope;
}): Promise<WorkflowSessionRecord> {
  const provenance = params.requestProvenance || { actorType: 'user' };
  const result = await db.query<Row>(
    `INSERT INTO workflow_sessions (
       id,workspace_id,workflow_id,workflow_version,created_by,compiled_access_scope,workflow_snapshot,
       request_actor_type,request_external_integration_link_id,request_external_integration_client_id,
       conversation_origin,agent_id,access_mode,agent_chat_read_scope,agent_chat_capability_ceiling
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [params.sessionId || randomUUID(), params.workflow.workspaceId, params.workflow.id, params.workflow.version,
     params.createdBy, params.compiledAccessScope, params.workflow, provenance.actorType,
     provenance.externalIntegrationLinkId || null, provenance.externalIntegrationClientId || null,
     params.conversationOrigin || 'workflow', params.agentId || null, params.accessMode || 'read_only',
     params.agentChatReadScope || null, params.agentChatCapabilityCeiling || null]
  );
  return mapSession(result.rows[0]);
}

export async function listAgentConversationSessions(
  workspaceId: string,
  agentId: string
): Promise<WorkflowSessionRecord[]> {
  const result = await db.query<Row>(
    `SELECT * FROM workflow_sessions
     WHERE workspace_id=$1 AND agent_id=$2 AND conversation_origin='agent_chat'
     ORDER BY created_at DESC,id DESC`,
    [workspaceId, agentId]
  );
  return result.rows.map(mapSession);
}

export async function setAgentConversationAccessMode(
  sessionId: string,
  accessMode: WorkflowSessionRecord['accessMode']
): Promise<WorkflowSessionRecord | null> {
  const result = await db.query<Row>(
    `UPDATE workflow_sessions
     SET access_mode=$2,
         compiled_access_scope=CASE
           WHEN $2='read_write' THEN agent_chat_capability_ceiling
           ELSE agent_chat_read_scope
         END
     WHERE id=$1 AND conversation_origin='agent_chat'
     RETURNING *`,
    [sessionId, accessMode]
  );
  return result.rowCount ? mapSession(result.rows[0]) : null;
}

export async function deleteAgentConversationSession(sessionId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM workflow_sessions WHERE id=$1 AND conversation_origin='agent_chat'`,
    [sessionId]
  );
  return Boolean(result.rowCount);
}

export async function listWorkflowSessions(
  workspaceId: string,
  workflowId: string
): Promise<WorkflowSessionRecord[]> {
  const result = await db.query<Row>(
    `SELECT * FROM workflow_sessions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY created_at DESC,id DESC`,
    [workspaceId, workflowId]
  );
  return result.rows.map(mapSession);
}

export async function getWorkflowSession(sessionId: string): Promise<WorkflowSessionRecord | null> {
  const result = await db.query<Row>('SELECT * FROM workflow_sessions WHERE id=$1', [sessionId]);
  return result.rowCount ? mapSession(result.rows[0]) : null;
}
