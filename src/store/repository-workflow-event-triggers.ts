import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { db } from '../infra/db.js';
import type {
  WorkflowEventInputBinding,
  WorkflowEventTriggerInput,
  WorkflowEventTriggerLastStatus,
  WorkflowEventTriggerPatch,
  WorkflowEventTriggerRecord
} from '../types/workflows.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

export interface ClaimedWorkflowEventTriggerDelivery {
  id: string;
  eventId: string;
  workspaceId: string;
  trigger: WorkflowEventTriggerRecord;
  eventType: string;
  sourceType: 'webhook' | 'issue';
  sourceId: string;
  occurrenceKey: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  attemptCount: number;
}

function actorMetadata(userId: string): { userId: string } {
  return { userId };
}

function bindingRecord(value: unknown): Record<string, WorkflowEventInputBinding> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, WorkflowEventInputBinding>
    : {};
}

function mapTrigger(row: QueryResultRow): WorkflowEventTriggerRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersion: Number(row.workflow_version),
    parameterSignature: row.parameter_signature,
    name: row.name,
    status: row.status,
    sourceType: row.source_type,
    ...(row.event_type ? { eventType: row.event_type } : {}),
    inputBindings: bindingRecord(row.input_bindings),
    approvedContextGrants: Array.isArray(row.approved_context_grants) ? row.approved_context_grants : [],
    principal: row.principal,
    ...(row.secret_ciphertext ? { secretCiphertext: row.secret_ciphertext } : {}),
    ...(row.secret_key_id ? { secretKeyId: row.secret_key_id } : {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    ...(row.last_triggered_at ? { lastTriggeredAt: toIso(row.last_triggered_at)! } : {}),
    ...(row.last_status ? { lastStatus: row.last_status } : {}),
    ...(row.last_execution_id ? { lastExecutionId: row.last_execution_id } : {}),
    ...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

export async function listWorkflowEventTriggers(workspaceId: string): Promise<WorkflowEventTriggerRecord[]> {
  const result = await db.query(
    `SELECT *
     FROM workflow_event_triggers
     WHERE workspace_id=$1
     ORDER BY created_at DESC,id`,
    [workspaceId]
  );
  return result.rows.map(mapTrigger);
}

export async function getWorkflowEventTrigger(triggerId: string): Promise<WorkflowEventTriggerRecord | null> {
  const result = await db.query(
    'SELECT * FROM workflow_event_triggers WHERE id=$1',
    [triggerId]
  );
  return result.rowCount ? mapTrigger(result.rows[0]) : null;
}

export async function createWorkflowEventTrigger(params: {
  workspaceId: string;
  workflowVersion: number;
  parameterSignature: string;
  actorUserId: string;
  input: WorkflowEventTriggerInput;
  secretCiphertext?: string;
  secretKeyId?: string;
}): Promise<WorkflowEventTriggerRecord> {
  const id = randomUUID();
  const actor = actorMetadata(params.actorUserId);
  const result = await db.query(
    `INSERT INTO workflow_event_triggers (
       id,workspace_id,workflow_id,workflow_version,parameter_signature,name,status,
       source_type,event_type,input_bindings,approved_context_grants,principal,
       secret_ciphertext,secret_key_id,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$15::jsonb
     ) RETURNING *`,
    [
      id,
      params.workspaceId,
      params.input.workflowId,
      params.workflowVersion,
      params.parameterSignature,
      params.input.name.trim(),
      params.input.enabled === false ? 'paused' : 'enabled',
      params.input.sourceType,
      params.input.eventType || null,
      JSON.stringify(params.input.inputBindings || {}),
      JSON.stringify(params.input.approvedContextGrants || []),
      JSON.stringify(params.input.principal),
      params.secretCiphertext || null,
      params.secretKeyId || null,
      JSON.stringify(actor)
    ]
  );
  return mapTrigger(result.rows[0]);
}

export async function updateWorkflowEventTriggerRecord(
  triggerId: string,
  patch: WorkflowEventTriggerPatch & {
    workflowVersion?: number;
    parameterSignature?: string;
  },
  actorUserId: string
): Promise<WorkflowEventTriggerRecord | null> {
  const current = await getWorkflowEventTrigger(triggerId);
  if (!current) return null;
  const status = typeof patch.enabled === 'boolean'
    ? patch.enabled ? 'enabled' : 'paused'
    : current.status;
  const result = await db.query(
    `UPDATE workflow_event_triggers
     SET workflow_version=$2,
         parameter_signature=$3,
         name=$4,
         status=$5,
         input_bindings=$6::jsonb,
         approved_context_grants=$7::jsonb,
         principal=$8::jsonb,
         updated_by=$9::jsonb,
         updated_at=NOW(),
         last_error=CASE WHEN $5='enabled' THEN NULL ELSE last_error END
     WHERE id=$1
     RETURNING *`,
    [
      triggerId,
      patch.workflowVersion || current.workflowVersion,
      patch.parameterSignature || current.parameterSignature,
      patch.name?.trim() || current.name,
      status,
      JSON.stringify(patch.inputBindings || current.inputBindings),
      JSON.stringify(patch.approvedContextGrants || current.approvedContextGrants),
      JSON.stringify(current.principal),
      JSON.stringify(actorMetadata(actorUserId))
    ]
  );
  return result.rowCount ? mapTrigger(result.rows[0]) : null;
}

export async function deleteWorkflowEventTriggerRecord(triggerId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const deliveries = await client.query<{ event_id: string }>(
      'DELETE FROM automation_trigger_deliveries WHERE trigger_id=$1 RETURNING event_id',
      [triggerId]
    );
    const eventIds = deliveries.rows.map((row) => row.event_id);
    if (eventIds.length) {
      await client.query(
        `DELETE FROM automation_trigger_events event
         WHERE event.id=ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM automation_trigger_deliveries delivery WHERE delivery.event_id=event.id
           )`,
        [eventIds]
      );
    }
    const result = await client.query('DELETE FROM workflow_event_triggers WHERE id=$1', [triggerId]);
    return Boolean(result.rowCount);
  });
}

export async function rotateWorkflowEventTriggerSecret(
  triggerId: string,
  secretCiphertext: string,
  secretKeyId: string,
  actorUserId: string
): Promise<WorkflowEventTriggerRecord | null> {
  const result = await db.query(
    `UPDATE workflow_event_triggers
     SET secret_ciphertext=$2,secret_key_id=$3,updated_by=$4::jsonb,updated_at=NOW()
     WHERE id=$1 AND source_type='webhook'
     RETURNING *`,
    [triggerId, secretCiphertext, secretKeyId, JSON.stringify(actorMetadata(actorUserId))]
  );
  return result.rowCount ? mapTrigger(result.rows[0]) : null;
}

export async function enqueueWorkflowIssueCreatedEvent(
  client: Pick<PoolClient, 'query'>,
  input: {
    workspaceId: string;
    issueId: string;
    lifecycleVersion: number;
    occurredAt: string;
    payload: Record<string, unknown>;
  }
): Promise<boolean> {
  const matching = await client.query(
    `SELECT 1
     FROM workflow_event_triggers
     WHERE workspace_id=$1
       AND status='enabled'
       AND source_type='acornops_event'
       AND event_type='issue.created.v1'
     LIMIT 1`,
    [input.workspaceId]
  );
  if (!matching.rowCount) return false;
  const eventId = randomUUID();
  const occurrenceKey = `${input.issueId}:${input.lifecycleVersion}:created`;
  const event = await client.query(
    `INSERT INTO automation_trigger_events (
       id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at
     ) VALUES ($1,$2,'issue.created.v1','issue',$3,$4,$5::jsonb,$6)
     ON CONFLICT (workspace_id,source_type,source_id,occurrence_key) DO NOTHING
     RETURNING id`,
    [eventId, input.workspaceId, input.issueId, occurrenceKey, JSON.stringify(input.payload), input.occurredAt]
  );
  if (!event.rowCount) return false;
  await client.query(
    `INSERT INTO automation_trigger_deliveries (id,event_id,workspace_id,trigger_id,status)
     SELECT gen_random_uuid()::text,$1,$2,trigger.id,'pending'
     FROM workflow_event_triggers trigger
     WHERE trigger.workspace_id=$2
       AND trigger.status='enabled'
       AND trigger.source_type='acornops_event'
       AND trigger.event_type='issue.created.v1'
     ON CONFLICT (event_id,trigger_id) DO NOTHING`,
    [eventId, input.workspaceId]
  );
  return true;
}

export async function acceptWorkflowWebhookEvent(input: {
  trigger: WorkflowEventTriggerRecord;
  eventId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  maxEventsPerMinute: number;
}): Promise<'accepted' | 'replayed' | 'inactive' | 'rate_limited'> {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT 1
       FROM workflow_event_triggers
       WHERE id=$1
         AND workspace_id=$2
         AND source_type='webhook'
         AND status='enabled'
         AND secret_ciphertext=$3
       FOR UPDATE`,
      [input.trigger.id, input.trigger.workspaceId, input.trigger.secretCiphertext]
    );
    if (!current.rowCount) return 'inactive';
    const replay = await client.query(
      `SELECT 1
       FROM automation_trigger_events
       WHERE workspace_id=$1
         AND source_type='webhook'
         AND source_id=$2
         AND occurrence_key=$3
       LIMIT 1`,
      [input.trigger.workspaceId, input.trigger.id, input.eventId]
    );
    if (replay.rowCount) return 'replayed';
    const recent = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM automation_trigger_events
       WHERE source_type='webhook'
         AND source_id=$1
         AND created_at > NOW()-INTERVAL '1 minute'`,
      [input.trigger.id]
    );
    if (Number(recent.rows[0]?.count || 0) >= input.maxEventsPerMinute) return 'rate_limited';
    const internalEventId = randomUUID();
    const event = await client.query(
      `INSERT INTO automation_trigger_events (
         id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at
       ) VALUES ($1,$2,'workflow.webhook.received.v1','webhook',$3,$4,$5::jsonb,$6)
       ON CONFLICT (workspace_id,source_type,source_id,occurrence_key) DO NOTHING
       RETURNING id`,
      [
        internalEventId,
        input.trigger.workspaceId,
        input.trigger.id,
        input.eventId,
        JSON.stringify(input.payload),
        input.occurredAt
      ]
    );
    if (!event.rowCount) return 'replayed';
    await client.query(
      `INSERT INTO automation_trigger_deliveries (id,event_id,workspace_id,trigger_id,status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), internalEventId, input.trigger.workspaceId, input.trigger.id]
    );
    return 'accepted';
  });
}

export async function claimWorkflowEventTriggerDeliveries(
  limit: number,
  claimOwner: string
): Promise<ClaimedWorkflowEventTriggerDelivery[]> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT delivery.id
         FROM automation_trigger_deliveries delivery
         JOIN workflow_event_triggers trigger
           ON trigger.id=delivery.trigger_id
         WHERE (
             delivery.status IN ('pending','failed')
             OR (delivery.status='claimed' AND delivery.claim_expires_at < NOW())
           )
           AND delivery.next_attempt_at <= NOW()
         ORDER BY delivery.created_at,delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT $1
       )
       UPDATE automation_trigger_deliveries delivery
       SET status='claimed',
           claim_owner=$2,
           claim_expires_at=NOW()+INTERVAL '5 minutes',
           updated_at=NOW()
       FROM candidates,workflow_event_triggers trigger,automation_trigger_events event
       WHERE delivery.id=candidates.id
         AND trigger.id=delivery.trigger_id
         AND event.id=delivery.event_id
       RETURNING delivery.id,delivery.event_id,delivery.workspace_id,delivery.attempt_count,
         to_jsonb(trigger) AS trigger_row,event.event_type AS source_event_type,event.source_type AS event_source_type,
         event.source_id,event.occurrence_key,event.payload,event.occurred_at`,
      [Math.max(1, Math.min(100, limit)), claimOwner]
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      trigger: mapTrigger(row.trigger_row),
      eventType: row.source_event_type,
      sourceType: row.event_source_type,
      sourceId: row.source_id,
      occurrenceKey: row.occurrence_key,
      payload: row.payload || {},
      occurredAt: toIso(row.occurred_at)!,
      attemptCount: Number(row.attempt_count)
    }));
  });
}

export async function finishWorkflowEventTriggerDelivery(input: {
  delivery: ClaimedWorkflowEventTriggerDelivery;
  status: 'delivered' | 'failed' | 'rejected';
  triggerStatus: WorkflowEventTriggerLastStatus;
  executionId?: string;
  runId?: string;
  error?: string;
  pauseTrigger?: boolean;
}): Promise<void> {
  const nextAttempt = input.status === 'failed'
    ? `NOW() + (${Math.min(30, 2 ** (input.delivery.attemptCount + 1))}::int * INTERVAL '1 second')`
    : 'NOW()';
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE automation_trigger_deliveries
       SET status=$2,
           attempt_count=attempt_count+1,
           next_attempt_at=${nextAttempt},
           rejection_code=$3,
           claim_owner=NULL,
           claim_expires_at=NULL,
           updated_at=NOW()
       WHERE id=$1`,
      [
        input.delivery.id,
        input.status,
        input.status === 'rejected' ? input.error || 'TRIGGER_REJECTED' : null
      ]
    );
    await client.query(
      `UPDATE workflow_event_triggers
       SET status=CASE WHEN $6 THEN 'paused' ELSE status END,
           last_triggered_at=NOW(),
           last_status=$2,
           last_execution_id=COALESCE($3,last_execution_id),
           last_run_id=COALESCE($4,last_run_id),
           last_error=$5,
           updated_at=NOW()
       WHERE id=$1`,
      [
        input.delivery.trigger.id,
        input.triggerStatus,
        input.executionId || null,
        input.runId || null,
        input.error || null,
        input.pauseTrigger === true
      ]
    );
  });
}
