import Redis from 'ioredis';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { RunEvent } from '../../types/domain.js';
import { distributedRoutingEnabled, parseJsonObject } from './common.js';

interface RunEventEnvelope {
  originInstanceId: string;
  runId: string;
  events: RunEvent[];
}

type RunEventHandler = (envelope: RunEventEnvelope) => void;

let runEventHandler: RunEventHandler | undefined;
let runEventSubscriber: Redis | undefined;

function runEventsChannel(): string {
  return 'cp:run-events';
}

function parseRunEventEnvelope(value: string): RunEventEnvelope | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed || typeof parsed.originInstanceId !== 'string' || typeof parsed.runId !== 'string' || !Array.isArray(parsed.events)) {
    return undefined;
  }
  return {
    originInstanceId: parsed.originInstanceId,
    runId: parsed.runId,
    events: parsed.events as RunEvent[]
  };
}

export function registerRunEventHandler(handler: RunEventHandler): void {
  runEventHandler = handler;
}

export async function startRunEventFanout(): Promise<void> {
  runEventSubscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
  runEventSubscriber.on('message', (_channel, message) => {
    handleRunEventMessage(message);
  });
  await runEventSubscriber.connect();
  await runEventSubscriber.subscribe(runEventsChannel());
}

export async function stopRunEventFanout(): Promise<void> {
  await runEventSubscriber?.quit().catch(() => undefined);
  runEventSubscriber = undefined;
}

function handleRunEventMessage(message: string): void {
  const envelope = parseRunEventEnvelope(message);
  if (!envelope || envelope.originInstanceId === config.CONTROL_PLANE_INSTANCE_ID) return;
  runEventHandler?.(envelope);
}

export function handleRunEventMessageForTests(message: string): void {
  handleRunEventMessage(message);
}

export async function publishRunEvents(runId: string, events: RunEvent[]): Promise<void> {
  if (!distributedRoutingEnabled() || events.length === 0) return;
  const envelope: RunEventEnvelope = {
    originInstanceId: config.CONTROL_PLANE_INSTANCE_ID,
    runId,
    events
  };
  await redis.publish(runEventsChannel(), JSON.stringify(envelope));
}
