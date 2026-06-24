import { RunEvent } from '../types/domain.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const RUN_EVENT_METRIC_TYPE_OTHER = 'other';
const RUN_EVENT_METRIC_TYPES = new Set([
  'run_progress',
  'run_started',
  'assistant_message_started',
  'assistant_token_delta',
  'assistant_reasoning_summary_delta',
  'assistant_reasoning_summary_completed',
  'assistant_reasoning_summary_unavailable',
  'tool_call_started',
  'tool_call_completed',
  'tool_approval_requested',
  'tool_approval_approved',
  'tool_approval_rejected',
  'tool_approval_expired',
  'assistant_message_completed',
  'run_failed',
  'run_cancelled',
  'run_completed'
]);

export function buildTerminalFailureMessage(status: string, errorMessage?: string): string {
  if (status === 'cancelled') {
    return 'I could not complete the troubleshooting run.\n\nThe run was cancelled.';
  }
  const detail = String(errorMessage || '').trim();
  return `I could not complete the troubleshooting run.\n\n${detail || 'No additional details were provided.'}`;
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function acceptsExecutionRunEvent(status: string, event: RunEvent): boolean {
  if (isTerminalRunStatus(status)) {
    return false;
  }
  if (status === 'cancelling') {
    return event.type === 'run_cancelled';
  }
  return true;
}

export function summarizeRunEventCounts(events: RunEvent[]): Map<string, number> {
  const eventCounts = new Map<string, number>();
  for (const event of events) {
    const eventType = RUN_EVENT_METRIC_TYPES.has(event.type) ? event.type : RUN_EVENT_METRIC_TYPE_OTHER;
    eventCounts.set(eventType, (eventCounts.get(eventType) || 0) + 1);
  }
  return eventCounts;
}
