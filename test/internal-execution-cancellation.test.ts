import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commitRun, ingestRunEvents } from '../src/controllers/internal-execution-controller.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import type { RunEvent } from '../src/types/domain.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const originalAppendRunEvents = repo.appendRunEvents;
const originalUpdateRun = repo.updateRun;
const originalUpsertAssistantFinalMessage = repo.upsertAssistantFinalMessage;
const originalWebhookEmit = webhooks.emit;

beforeEach(() => {
  webhooks.emit = (_event: WebhookEventInput) => undefined;
  repo.insertTargetChatActivityEvent = async (event) => ({
    id: 'activity-event-1',
    workspaceId: event.workspaceId,
    targetId: event.targetId,
    targetType: event.targetType,
    sessionId: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    type: event.type,
    payload: event.payload ?? {},
    createdAt: '2026-05-24T00:00:00.000Z'
  });
});

afterEach(() => {
  restoreControllerRegressionState();
  repo.appendRunEvents = originalAppendRunEvents;
  repo.updateRun = originalUpdateRun;
  repo.upsertAssistantFinalMessage = originalUpsertAssistantFinalMessage;
  webhooks.emit = originalWebhookEmit;
  runtime.clearRunEvents('run-1');
});

function createRunEvent(type: string, seq: number, payload: Record<string, unknown> = {}): RunEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    seq,
    ts: '2026-05-24T00:00:00.000Z',
    type,
    payload
  };
}

describe('internal execution cancellation handling', () => {
  it('drops late execution events for runs that are already cancelled', async () => {
    let appended = false;
    repo.getRun = async () => createRun({ status: 'cancelled' });
    repo.appendRunEvents = async () => {
      appended = true;
      return [];
    };

    const response = await callController(ingestRunEvents, createRequest({ runId: 'run-1' }, {
      events: [
        createRunEvent('assistant_token_delta', 10, { text: 'stale' }),
        createRunEvent('run_completed', 11)
      ]
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', accepted: 0 });
    assert.equal(appended, false);
  });

  it('accepts only run_cancelled while a run is cancelling', async () => {
    let appendedEvents: RunEvent[] = [];
    repo.getRun = async () => createRun({ status: 'cancelling' });
    repo.appendRunEvents = async (_runId, events) => {
      appendedEvents = events;
      return events;
    };
    repo.updateRun = async () => createRun({ status: 'cancelled' });

    const response = await callController(ingestRunEvents, createRequest({ runId: 'run-1' }, {
      events: [
        createRunEvent('run_progress', 1, { stage: 'reasoning' }),
        createRunEvent('run_cancelled', 2, { reason: 'user_cancelled' }),
        createRunEvent('assistant_token_delta', 3, { text: 'stale' })
      ]
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', accepted: 1 });
    assert.deepEqual(appendedEvents.map((event) => event.type), ['run_cancelled']);
  });

  it('does not mutate cancelled runs when a late terminal commit arrives', async () => {
    let updated = false;
    let upserted = false;
    repo.getRun = async () => createRun({ status: 'cancelled' });
    repo.updateRun = async () => {
      updated = true;
      return createRun({ status: 'completed' });
    };
    repo.upsertAssistantFinalMessage = async () => {
      upserted = true;
      return createMessage();
    };

    const response = await callController(commitRun, createRequest({ runId: 'run-1' }, {
      status: 'completed',
      assistant_message: { content: 'stale answer', format: 'markdown' },
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0 },
      timing: {
        started_at: '2026-05-24T00:00:00.000Z',
        ended_at: '2026-05-24T00:00:01.000Z'
      }
    }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ok', terminal: true });
    assert.equal(updated, false);
    assert.equal(upserted, false);
  });

  it('does not persist assistant content from cancelled execution commits', async () => {
    let assistantMessageContent: string | undefined;
    let upsertedContent: string | undefined;
    repo.getRun = async () => createRun({ status: 'running' });
    repo.updateRun = async (_runId, update) => {
      assistantMessageContent = String(update.assistantMessage?.content || '');
      return createRun({ status: 'cancelled', assistantMessage: update.assistantMessage });
    };
    repo.upsertAssistantFinalMessage = async (_sessionId, _runId, content) => {
      upsertedContent = content;
      return { ...createMessage(), role: 'assistant', kind: 'assistant', content };
    };

    const response = await callController(commitRun, createRequest({ runId: 'run-1' }, {
      status: 'cancelled',
      assistant_message: { content: 'stale partial answer', format: 'markdown' },
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0 },
      timing: {
        started_at: '2026-05-24T00:00:00.000Z',
        ended_at: '2026-05-24T00:00:01.000Z'
      }
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(assistantMessageContent, '');
    assert.equal(upsertedContent, 'I could not complete the troubleshooting run.\n\nThe run was cancelled.');
  });
});
