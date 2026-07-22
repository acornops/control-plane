import Redis from 'ioredis';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import type { WorkflowExecutionStreamEvent } from '../../store/repository-workflow-execution-events.js';
import { distributedRoutingEnabled, parseJsonObject } from './common.js';

interface WorkflowExecutionEventEnvelope {
  originInstanceId: string;
  executionId: string;
  events: WorkflowExecutionStreamEvent[];
}

type WorkflowExecutionEventHandler = (envelope: WorkflowExecutionEventEnvelope) => void;

let handler: WorkflowExecutionEventHandler | undefined;
let subscriber: Redis | undefined;

function channel(): string {
  return 'cp:workflow-execution-events';
}

function parseEnvelope(value: string): WorkflowExecutionEventEnvelope | undefined {
  const parsed = parseJsonObject(value);
  if (
    !parsed
    || typeof parsed.originInstanceId !== 'string'
    || typeof parsed.executionId !== 'string'
    || !Array.isArray(parsed.events)
  ) return undefined;
  return {
    originInstanceId: parsed.originInstanceId,
    executionId: parsed.executionId,
    events: parsed.events as WorkflowExecutionStreamEvent[]
  };
}

export function registerWorkflowExecutionEventHandler(next: WorkflowExecutionEventHandler): void {
  handler = next;
}

export async function startWorkflowExecutionEventFanout(): Promise<void> {
  subscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
  subscriber.on('message', (_channel, message) => {
    const envelope = parseEnvelope(message);
    if (!envelope || envelope.originInstanceId === config.CONTROL_PLANE_INSTANCE_ID) return;
    handler?.(envelope);
  });
  await subscriber.connect();
  await subscriber.subscribe(channel());
}

export async function stopWorkflowExecutionEventFanout(): Promise<void> {
  await subscriber?.quit().catch(() => undefined);
  subscriber = undefined;
}

export async function publishWorkflowExecutionEvents(
  executionId: string,
  events: WorkflowExecutionStreamEvent[]
): Promise<void> {
  if (!distributedRoutingEnabled() || events.length === 0) return;
  await redis.publish(channel(), JSON.stringify({
    originInstanceId: config.CONTROL_PLANE_INSTANCE_ID,
    executionId,
    events
  } satisfies WorkflowExecutionEventEnvelope));
}
