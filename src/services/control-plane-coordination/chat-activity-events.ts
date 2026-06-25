import Redis from 'ioredis';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { TargetChatActivityEvent } from '../../types/domain.js';
import { distributedRoutingEnabled, parseJsonObject } from './common.js';

interface TargetChatActivityEventEnvelope {
  originInstanceId: string;
  workspaceId: string;
  targetId: string;
  events: TargetChatActivityEvent[];
}

type TargetChatActivityEventHandler = (envelope: TargetChatActivityEventEnvelope) => void;

let targetChatActivityEventHandler: TargetChatActivityEventHandler | undefined;
let targetChatActivityEventSubscriber: Redis | undefined;

function targetChatActivityEventsChannel(): string {
  return 'cp:target-chat-activity-events';
}

function parseTargetChatActivityEventEnvelope(value: string): TargetChatActivityEventEnvelope | undefined {
  const parsed = parseJsonObject(value);
  if (
    !parsed ||
    typeof parsed.originInstanceId !== 'string' ||
    typeof parsed.workspaceId !== 'string' ||
    typeof parsed.targetId !== 'string' ||
    !Array.isArray(parsed.events)
  ) {
    return undefined;
  }
  return {
    originInstanceId: parsed.originInstanceId,
    workspaceId: parsed.workspaceId,
    targetId: parsed.targetId,
    events: parsed.events as TargetChatActivityEvent[]
  };
}

export function registerTargetChatActivityEventHandler(handler: TargetChatActivityEventHandler): void {
  targetChatActivityEventHandler = handler;
}

export async function startTargetChatActivityEventFanout(): Promise<void> {
  targetChatActivityEventSubscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
  targetChatActivityEventSubscriber.on('message', (_channel, message) => {
    handleTargetChatActivityEventMessage(message);
  });
  await targetChatActivityEventSubscriber.connect();
  await targetChatActivityEventSubscriber.subscribe(targetChatActivityEventsChannel());
}

export async function stopTargetChatActivityEventFanout(): Promise<void> {
  await targetChatActivityEventSubscriber?.quit().catch(() => undefined);
  targetChatActivityEventSubscriber = undefined;
}

function handleTargetChatActivityEventMessage(message: string): void {
  const envelope = parseTargetChatActivityEventEnvelope(message);
  if (!envelope || envelope.originInstanceId === config.CONTROL_PLANE_INSTANCE_ID) return;
  targetChatActivityEventHandler?.(envelope);
}

export async function publishTargetChatActivityEvents(
  workspaceId: string,
  targetId: string,
  events: TargetChatActivityEvent[]
): Promise<void> {
  if (!distributedRoutingEnabled() || events.length === 0) return;
  const envelope: TargetChatActivityEventEnvelope = {
    originInstanceId: config.CONTROL_PLANE_INSTANCE_ID,
    workspaceId,
    targetId,
    events
  };
  await redis.publish(targetChatActivityEventsChannel(), JSON.stringify(envelope));
}
