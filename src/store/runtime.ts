import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { RunEvent } from '../types/domain.js';

export interface RunStreamEvent {
  event: unknown;
}

export interface AgentCommandPending {
  id: string;
  createdAt: number;
  clusterId: string;
  connectionId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type BufferedRunEvent = RunEvent;

function sortBySeqAsc(events: BufferedRunEvent[]): BufferedRunEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq);
}

function trimToBufferSize(events: BufferedRunEvent[]): BufferedRunEvent[] {
  if (events.length <= config.RUN_EVENT_BUFFER_SIZE) return events;
  return events.slice(events.length - config.RUN_EVENT_BUFFER_SIZE);
}

export const runtime = {
  runStreams: new EventEmitter(),
  workflowExecutionStreams: new EventEmitter(),
  targetChatActivityStreams: new EventEmitter(),
  agentCommands: new Map<string, AgentCommandPending>(),
  runEventBuffer: new Map<string, BufferedRunEvent[]>(),
  appendRunEvents(runId: string, events: BufferedRunEvent[]): BufferedRunEvent[] {
    if (events.length === 0) return [];
    const existing = this.runEventBuffer.get(runId) || [];
    const seen = new Set(existing.map((event) => event.seq));
    const newlyAccepted: BufferedRunEvent[] = [];
    for (const event of sortBySeqAsc(events)) {
      if (seen.has(event.seq)) continue;
      newlyAccepted.push(event);
      seen.add(event.seq);
    }
    if (newlyAccepted.length === 0) return [];
    const merged = trimToBufferSize(sortBySeqAsc([...existing, ...newlyAccepted]));
    this.runEventBuffer.set(runId, merged);
    return newlyAccepted;
  },
  getRunEvents(runId: string): BufferedRunEvent[] {
    return sortBySeqAsc(this.runEventBuffer.get(runId) || []);
  },
  clearRunEvents(runId: string): void {
    this.runEventBuffer.delete(runId);
  }
};
