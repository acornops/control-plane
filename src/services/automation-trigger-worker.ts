import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementAutomationTrigger } from '../metrics.js';
import { getAgentDefinition, createAgentRunActivity } from '../store/repository-agents.js';
import { withTransaction } from '../store/repository-transaction.js';
import { computeNextWorkflowScheduleRunAt } from '../store/repository-workflow-schedules.js';
import type { TargetType } from '../types/domain.js';
import { compileAgentRunScope } from './agent-access.js';
import { resolveRunPrincipal } from './run-principal.js';
import { getExactMcpReadinessErrors } from './workflow-readiness.js';
import { listCapabilityRoutingMappings } from '../store/repository-capability-routing.js';
import { repo } from '../store/repository.js';

type DeliveryRow = {
  id: string;
  event_id: string;
  workspace_id: string;
  trigger_id: string;
  attempt_count: number;
  agent_id: string;
  principal: { type: 'user' | 'service_identity'; id: string } | null;
  event_filter: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  source_type: 'webhook' | 'schedule' | 'target_event';
};

const workerId = `${config.CONTROL_PLANE_INSTANCE_ID}:${randomUUID()}`;

async function claim(limit: number): Promise<DeliveryRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<DeliveryRow>(
      `WITH candidates AS (
         SELECT delivery.id
         FROM automation_trigger_deliveries delivery
         JOIN agent_triggers trigger ON trigger.id=delivery.trigger_id AND trigger.enabled=true
         WHERE delivery.status IN ('pending','failed')
           AND delivery.next_attempt_at <= NOW()
           AND (delivery.claim_expires_at IS NULL OR delivery.claim_expires_at < NOW())
         ORDER BY delivery.created_at,delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT $1
       )
       UPDATE automation_trigger_deliveries delivery
       SET status='claimed',claim_owner=$2,claim_expires_at=NOW()+INTERVAL '30 seconds',updated_at=NOW()
       FROM candidates,
            agent_triggers trigger,
            automation_trigger_events event
       WHERE delivery.id=candidates.id
         AND trigger.id=delivery.trigger_id
         AND event.id=delivery.event_id
       RETURNING delivery.id,delivery.event_id,delivery.workspace_id,delivery.trigger_id,
         delivery.attempt_count,trigger.agent_id,trigger.principal,trigger.event_filter,event.payload,event.source_type`,
      [limit, workerId]
    );
    return result.rows;
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

async function reject(row: DeliveryRow, code: string): Promise<void> {
  await db.query(
    `UPDATE automation_trigger_deliveries SET status='rejected',rejection_code=$2,
     claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1`,
    [row.id, code]
  );
  incrementAutomationTrigger(row.source_type, `rejected_${code.toLowerCase()}`);
}

async function retry(row: DeliveryRow): Promise<void> {
  const attempt = row.attempt_count + 1;
  await db.query(
    `UPDATE automation_trigger_deliveries SET status=$2,attempt_count=$3,
     next_attempt_at=NOW()+($4::text||' seconds')::interval,claim_owner=NULL,claim_expires_at=NULL,
     rejection_code=$5,updated_at=NOW() WHERE id=$1`,
    [row.id, attempt >= 3 ? 'rejected' : 'failed', attempt, Math.min(30, 2 ** attempt),
     attempt >= 3 ? 'TRIGGER_DELIVERY_RETRIES_EXHAUSTED' : null]
  );
  incrementAutomationTrigger(row.source_type, attempt >= 3 ? 'retries_exhausted' : 'retry');
}

async function deliver(row: DeliveryRow): Promise<void> {
  const agent = await getAgentDefinition(row.workspace_id, row.agent_id);
  if (!agent || agent.status !== 'active') return reject(row, 'AGENT_NOT_ACTIVE');
  if (agent.readiness.status !== 'ready') return reject(row, 'AGENT_NOT_READY');
  if (!row.principal) return reject(row, 'TRIGGER_PRINCIPAL_REQUIRED');
  const actor = await resolveRunPrincipal(row.workspace_id, row.principal);
  if (!actor) return reject(row, 'TRIGGER_PRINCIPAL_NOT_AUTHORIZED');
  const approvedContextGrants = stringArray(row.event_filter?.approvedContextGrants);
  const targetId = typeof row.payload.targetId === 'string' && row.payload.targetId.trim()
    ? row.payload.targetId.trim()
    : undefined;
  const requestedTargetType = row.payload.targetType === 'kubernetes' || row.payload.targetType === 'virtual_machine'
    ? row.payload.targetType as TargetType
    : undefined;
  const target = targetId ? await repo.getTarget(row.workspace_id, targetId) : null;
  if (targetId && !target) return reject(row, 'TRIGGER_TARGET_NOT_FOUND');
  if (target && target.status === 'offline') return reject(row, 'TRIGGER_TARGET_NOT_READY');
  if (target && requestedTargetType && requestedTargetType !== target.targetType) {
    return reject(row, 'TRIGGER_TARGET_TYPE_MISMATCH');
  }
  const mappings = await listCapabilityRoutingMappings(row.workspace_id, {
    activeReviewedOnly: true,
    capabilityIds: agent.semanticCapabilityIds
  });
  let compiledScope;
  try {
    compiledScope = compileAgentRunScope({
      agent,
      triggerId: row.trigger_id,
      approvedContextGrants,
      principal: row.principal,
      actor,
      mappings,
      exactTarget: target ? { id: target.id, targetType: target.targetType } : undefined
    });
  } catch {
    return reject(row, 'TRIGGER_SCOPE_NOT_APPROVED');
  }
  const readinessErrors = await getExactMcpReadinessErrors(
    row.workspace_id,
    compiledScope.principal,
    compiledScope.mcpTools
  );
  if (readinessErrors.length > 0) {
    return reject(
      row,
      readinessErrors[0].startsWith('MCP_PAT_USER_PRINCIPAL_REQUIRED')
        ? 'MCP_PAT_USER_PRINCIPAL_REQUIRED'
        : 'MCP_PERSONAL_CONNECTION_REQUIRED'
    );
  }
  const targetType = target?.targetType;
  const prompt = typeof row.payload.prompt === 'string' && row.payload.prompt.trim()
    ? row.payload.prompt.trim().slice(0, 20_000)
    : 'Process the accepted automation event using only the compiled Agent scope.';
  try {
    await createAgentRunActivity({
      agent,
      triggerId: row.trigger_id,
      triggeredBy: { type: row.source_type === 'webhook' ? 'webhook' : row.source_type === 'schedule' ? 'schedule' : 'system' },
      prompt,
      inputContext: { eventId: row.event_id, payload: row.payload },
      compiledScope,
      clientRequestId: `trigger-event:${row.event_id}`,
      targetId,
      targetType
    });
    await db.query(
      `UPDATE automation_trigger_deliveries SET status='delivered',attempt_count=attempt_count+1,
       claim_owner=NULL,claim_expires_at=NULL,updated_at=NOW() WHERE id=$1`,
      [row.id]
    );
    incrementAutomationTrigger(row.source_type, 'delivered');
  } catch (error) {
    logger.warn({ deliveryId: row.id, triggerId: row.trigger_id }, 'Automation trigger delivery failed');
    await retry(row);
  }
}

async function emitDueScheduleEvents(limit: number): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      workspace_id: string; agent_id: string; id: string;
      schedule: { cron: string; timezone: string }; event_filter: Record<string, unknown> | null;
    }>(
      `SELECT trigger.workspace_id,trigger.agent_id,trigger.id,trigger.schedule,trigger.event_filter
       FROM agent_triggers trigger
       WHERE trigger.type='schedule' AND trigger.enabled=true AND trigger.next_occurrence_at <= NOW()
       ORDER BY trigger.next_occurrence_at,trigger.id FOR UPDATE SKIP LOCKED LIMIT $1`,
      [limit]
    );
    for (const trigger of result.rows) {
      const occurrenceKey = new Date().toISOString().slice(0, 16);
      const active = await client.query(
        `SELECT 1 FROM agent_activity WHERE workspace_id=$1 AND trigger_id=$2 AND status IN ('queued','running') LIMIT 1`,
        [trigger.workspace_id, trigger.id]
      );
      const next = computeNextWorkflowScheduleRunAt(
        trigger.schedule.cron, new Date(), trigger.schedule.timezone
      );
      await client.query(
        'UPDATE agent_triggers SET next_occurrence_at=$2,updated_at=NOW() WHERE id=$1',
        [trigger.id, next || null]
      );
      if (active.rowCount) {
        incrementAutomationTrigger('schedule', 'overlap_skipped');
        continue;
      }
      const eventId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO automation_trigger_events
          (id,workspace_id,event_type,source_type,source_id,occurrence_key,payload,occurred_at)
         VALUES ($1,$2,'agent.schedule.due.v1','schedule',$3,$4,$5,NOW())
         ON CONFLICT (workspace_id,source_type,source_id,occurrence_key) DO NOTHING RETURNING id`,
        [eventId, trigger.workspace_id, trigger.id, occurrenceKey,
         { prompt: 'Run the scheduled Agent automation.', ...(trigger.event_filter?.inputContext || {}) }]
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO automation_trigger_deliveries (id,event_id,workspace_id,trigger_id,status)
           VALUES ($1,$2,$3,$4,'pending')`,
          [randomUUID(), eventId, trigger.workspace_id, trigger.id]
        );
        incrementAutomationTrigger('schedule', 'emitted');
      } else {
        incrementAutomationTrigger('schedule', 'deduplicated');
      }
    }
    return result.rowCount || 0;
  });
}

export async function runAutomationTriggerTick(limit = 25): Promise<number> {
  if (config.AUTOMATION_RUNTIME_MODE === 'off' || config.AUTOMATION_RUNTIME_MODE === 'shadow') return 0;
  await emitDueScheduleEvents(limit);
  const rows = await claim(limit);
  for (const row of rows) await deliver(row);
  return rows.length;
}
