import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TargetType } from '../types/domain.js';

export async function enqueueTargetAutomationEvent(
  client: PoolClient,
  input: {
    workspaceId: string;
    targetId: string;
    targetType: TargetType;
    eventType: string;
    occurrenceKey: string;
    occurredAt: string;
  }
): Promise<boolean> {
  const eventId = randomUUID();
  const event = await client.query(
    `INSERT INTO automation_trigger_events
      (id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at)
     VALUES ($1,$2,$3,'target_event',$4,$5,$6,$7)
     ON CONFLICT (workspace_id,source_type,source_id,occurrence_key) DO NOTHING RETURNING id`,
    [eventId, input.workspaceId, input.eventType, input.targetId, input.occurrenceKey,
     { targetId: input.targetId, targetType: input.targetType, eventType: input.eventType }, input.occurredAt]
  );
  if (!event.rowCount) return false;
  await client.query(
    `INSERT INTO automation_trigger_deliveries (id,event_id,workspace_id,trigger_id,status)
     SELECT gen_random_uuid()::text,$1,$2,trigger.id,'pending'
     FROM agent_triggers trigger
     WHERE trigger.workspace_id=$2 AND trigger.type='target_event' AND trigger.enabled=true
       AND (trigger.event_filter->'eventTypes' IS NULL OR trigger.event_filter->'eventTypes' ? $3)
       AND (trigger.event_filter->'targetIds' IS NULL OR trigger.event_filter->'targetIds' ? $4)
       AND (trigger.event_filter->'targetTypes' IS NULL OR trigger.event_filter->'targetTypes' ? $5)
     ON CONFLICT (event_id,trigger_id) DO NOTHING`,
    [eventId, input.workspaceId, input.eventType, input.targetId, input.targetType]
  );
  return true;
}
