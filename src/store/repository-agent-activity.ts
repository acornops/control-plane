import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import type { AgentActivityRecord, AgentDefinition, CompiledAgentRunScope } from '../types/agents.js';
import type { RunEvent } from '../types/domain.js';
import { insertAutomationRunApproval } from './repository-automation-approvals.js';
import { withTransaction } from './repository-transaction.js';

const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

function mapActivity(row: QueryResultRow): AgentActivityRecord {
  return {
    id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, agentVersion: row.agent_version,
    triggerId: row.trigger_id || undefined, clientRequestId: row.client_request_id || undefined,
    targetId: row.target_id || undefined, targetType: row.target_type || undefined,
    idempotencyKey: row.idempotency_key || undefined, agentSnapshot: row.agent_snapshot || undefined,
    status: row.status, triggeredBy: row.triggered_by,
    inputContext: row.input_context || {}, compiledScope: row.compiled_scope,
    toolCalls: row.tool_calls || [], outputArtifacts: row.output_artifacts || [],
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at), errorCode: row.error_code || undefined, errorMessage: row.error_message || undefined,
    assistantMessage: row.assistant_message || undefined, usage: row.usage || undefined
  };
}

export async function createAgentRunActivity(input: {
  agent: AgentDefinition;
  triggerId?: string;
  triggeredBy: AgentActivityRecord['triggeredBy'];
  prompt: string;
  inputContext: Record<string, unknown>;
  compiledScope: CompiledAgentRunScope;
  clientRequestId?: string;
  targetId?: string;
  targetType?: AgentActivityRecord['targetType'];
}): Promise<AgentActivityRecord> {
  return withTransaction(async (client) => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const status = input.agent.approvalPolicy.mode === 'always' ? 'waiting_for_approval' : 'queued';
    const idempotencyKey = input.clientRequestId
      ? `${input.agent.workspaceId}:agent:${input.clientRequestId}`
      : `${input.agent.workspaceId}:agent:${id}`;
    if (input.clientRequestId) {
      const existing = await client.query<QueryResultRow>(
        'SELECT * FROM agent_activity WHERE workspace_id=$1 AND client_request_id=$2 FOR UPDATE',
        [input.agent.workspaceId, input.clientRequestId]
      );
      if (existing.rowCount) return mapActivity(existing.rows[0]);
    }
    const result = await client.query<QueryResultRow>(
      `INSERT INTO agent_activity (
        workspace_id,agent_id,id,agent_version,trigger_id,client_request_id,target_id,target_type,idempotency_key,agent_snapshot,
        status,triggered_by,input_context,compiled_scope,tool_calls,output_artifacts,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'[]','[]',$15,$15) RETURNING *`,
      [input.agent.workspaceId, input.agent.id, id, input.agent.version, input.triggerId || null,
       input.clientRequestId || null, input.targetId || null, input.targetType || null, idempotencyKey,
       input.agent, status, input.triggeredBy, { ...input.inputContext, prompt: input.prompt }, input.compiledScope, now]
    );
    if (status === 'waiting_for_approval') {
      await insertAutomationRunApproval(client, {
        workspaceId: input.agent.workspaceId,
        sourceType: 'agent',
        sourceId: input.agent.id,
        runId: id,
        targetId: input.targetId,
        targetType: input.targetType,
        approvalKind: 'pre_step',
        toolCallId: `agent-pre-step:${input.agent.version}`,
        toolName: 'agent.pre_step',
        summary: `Approve Agent run: ${input.agent.name}`,
        requestedBy: input.triggeredBy.userId,
        expiresAt: new Date(Date.now() + config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString()
      });
    }
    await client.query(
      'UPDATE agent_definitions SET run_count=run_count+1,last_run_at=$3,last_status=$4,updated_at=NOW() WHERE workspace_id=$1 AND id=$2',
      [input.agent.workspaceId, input.agent.id, now, status]
    );
    await client.query(
      `INSERT INTO automation_dispatch_outbox (id,workspace_id,source_type,source_id,run_id,idempotency_key,payload)
       VALUES ($1,$2,'agent',$3,$4,$5,$6)`,
      [randomUUID(), input.agent.workspaceId, input.agent.id, id, idempotencyKey,
       { runId: id, agentId: input.agent.id, agentVersion: input.agent.version, targetId: input.targetId || null }]
    );
    return mapActivity(result.rows[0]);
  });
}

export async function getAgentActivityRecord(runId: string): Promise<AgentActivityRecord | null> {
  const result = await db.query<QueryResultRow>('SELECT * FROM agent_activity WHERE id=$1', [runId]);
  return result.rowCount ? mapActivity(result.rows[0]) : null;
}

export async function updateAgentActivityRecord(
  runId: string,
  update: Partial<Pick<AgentActivityRecord, 'status'|'startedAt'|'endedAt'|'errorCode'|'errorMessage'|'assistantMessage'|'usage'>>
): Promise<AgentActivityRecord | null> {
  const columns: Record<string,string> = { status:'status',startedAt:'started_at',endedAt:'ended_at',errorCode:'error_code',errorMessage:'error_message',assistantMessage:'assistant_message',usage:'usage' };
  const entries = Object.entries(update).filter(([key]) => columns[key]);
  if (!entries.length) return getAgentActivityRecord(runId);
  const values: unknown[] = [runId];
  const sets = entries.map(([key,value]) => { values.push(value ?? null); return `${columns[key]}=$${values.length}`; });
  const result = await db.query<QueryResultRow>(`UPDATE agent_activity SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`, values);
  return result.rowCount ? mapActivity(result.rows[0]) : null;
}

export async function appendAgentRunEvents(run: AgentActivityRecord, events: RunEvent[]): Promise<RunEvent[]> {
  const accepted: RunEvent[] = [];
  for (const event of events) {
    const result = await db.query(
      `INSERT INTO agent_run_events (run_id,workspace_id,seq,schema_version,event_type,occurred_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id,seq) DO NOTHING RETURNING seq`,
      [run.id, run.workspaceId, event.seq, event.schema_version, event.type, event.ts, event.payload || {}]
    );
    if (result.rowCount) accepted.push(event);
  }
  return accepted;
}

export async function listAgentRunEvents(runId: string): Promise<RunEvent[]> {
  const result = await db.query<QueryResultRow>('SELECT * FROM agent_run_events WHERE run_id=$1 ORDER BY seq', [runId]);
  return result.rows.map((row) => ({ schema_version: row.schema_version, run_id: row.run_id,
    seq: row.seq, ts: iso(row.occurred_at)!, type: row.event_type, payload: row.payload || {} } as RunEvent));
}

export async function listAgentActivityRecords(workspaceId: string, agentId: string): Promise<AgentActivityRecord[]> {
  const result = await db.query<QueryResultRow>(
    'SELECT * FROM agent_activity WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC', [workspaceId, agentId]
  );
  return result.rows.map(mapActivity);
}
