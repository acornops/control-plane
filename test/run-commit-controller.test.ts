import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { commitRun } from '../src/controllers/internal-execution-controller.js';
import { webhooks, type WebhookEventInput } from '../src/services/webhooks.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createMessage,
  createRequest,
  createRun,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const originalWebhookEmit = webhooks.emit;

beforeEach(() => {
  webhooks.emit = (_event: WebhookEventInput) => undefined;
  repo.insertWorkspaceAuditEvent = async (event) => ({
    id: 'audit-event-1',
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    actor: {
      type: event.actorType || (event.actorUserId ? 'user' : 'system'),
      ...(event.actorUserId ? { userId: event.actorUserId } : {})
    },
    object: {
      type: event.objectType,
      ...(event.objectId ? { id: event.objectId } : {}),
      ...(event.objectName ? { name: event.objectName } : {})
    },
    summary: event.summary,
    metadata: event.metadata ?? {},
    occurredAt: '2026-05-24T00:00:00.000Z'
  });
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
  webhooks.emit = originalWebhookEmit;
});

test('run commit controller persists completed commits that use UTC offset timestamps', async () => {
  let updateStartedAt: string | undefined;
  let updateEndedAt: string | undefined;
  let upsertedContent: string | undefined;

  repo.getRun = async () => createRun({ status: 'running' });
  repo.updateRun = async (_runId, update) => {
    updateStartedAt = update.startedAt || undefined;
    updateEndedAt = update.endedAt || undefined;
    return createRun({ status: 'completed', assistantMessage: update.assistantMessage });
  };
  repo.upsertAssistantFinalMessage = async (_sessionId, _runId, content) => {
    upsertedContent = content;
    return createMessage({
      role: 'assistant',
      kind: 'assistant_final',
      content
    });
  };

  const response = await callController(commitRun, createRequest({ runId: 'run-1' }, {
    status: 'completed',
    assistant_message: { content: 'done', format: 'markdown' },
    usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0 },
    timing: {
      started_at: '2026-06-22T14:45:00.000000+00:00',
      ended_at: '2026-06-22T14:45:15.000000+00:00'
    }
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'ok' });
  assert.equal(updateStartedAt, '2026-06-22T14:45:00.000000+00:00');
  assert.equal(updateEndedAt, '2026-06-22T14:45:15.000000+00:00');
  assert.equal(upsertedContent, 'done');
});
