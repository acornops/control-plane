import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { emitRunStatusTransition, webhooks, type WebhookEventInput } from '../../src/services/webhooks.js';
import { repo } from '../../src/store/repository.js';
import type { Run } from '../../src/types/domain.js';

const originalInsertWorkspaceAuditEvent = repo.insertWorkspaceAuditEvent;
const originalInsertTargetChatActivityEvent = repo.insertTargetChatActivityEvent;
const originalWebhookEmit = webhooks.emit;

function createRun(status: Run['status'], overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    toolAccessMode: 'read_only',
    status,
    requestedAt: '2026-05-06T00:00:00.000Z',
    ...overrides
  };
}

beforeEach(() => {
  repo.insertTargetChatActivityEvent = async (event) => ({
    ...event,
    id: 'activity-event-1',
    payload: event.payload ?? {},
    createdAt: '2026-05-06T00:00:00.000Z'
  });
  repo.insertWorkspaceAuditEvent = async (event) => ({
    id: 'audit-event-1',
    workspaceId: event.workspaceId,
    category: event.category,
    eventType: event.eventType,
    actor: { type: event.actorType || (event.actorUserId ? 'user' : 'system') },
    object: { type: event.objectType, ...(event.objectId ? { id: event.objectId } : {}) },
    summary: event.summary,
    metadata: event.metadata || {},
    occurredAt: '2026-05-06T00:00:00.000Z'
  });
});

afterEach(() => {
  repo.insertWorkspaceAuditEvent = originalInsertWorkspaceAuditEvent;
  repo.insertTargetChatActivityEvent = originalInsertTargetChatActivityEvent;
  webhooks.emit = originalWebhookEmit;
});

describe('emitRunStatusTransition', () => {
  it('emits run.started.v1 when a run first enters running', () => {
    const events: WebhookEventInput[] = [];
    webhooks.emit = (input) => {
      events.push(input);
    };

    emitRunStatusTransition(createRun('dispatching'), createRun('running', { startedAt: '2026-05-06T00:00:01.000Z' }));

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: 'run.started.v1',
      workspaceId: 'ws-1',
      clusterId: 'cluster-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      subject: { type: 'run', id: 'run-1' },
      data: {
        sessionId: 'session-1',
        messageId: 'message-1',
        status: 'running',
        startedAt: '2026-05-06T00:00:01.000Z'
      }
    });
  });

  it('emits the correct terminal event when a run reaches a terminal status', () => {
    const cases: Array<{ status: Extract<Run['status'], 'completed' | 'failed' | 'cancelled'>; type: WebhookEventInput['type'] }> = [
      { status: 'completed', type: 'run.completed.v1' },
      { status: 'failed', type: 'run.failed.v1' },
      { status: 'cancelled', type: 'run.cancelled.v1' }
    ];

    for (const testCase of cases) {
      const events: WebhookEventInput[] = [];
      webhooks.emit = (input) => {
        events.push(input);
      };

      emitRunStatusTransition(
        createRun('running'),
        createRun(testCase.status, {
          startedAt: '2026-05-06T00:00:01.000Z',
          endedAt: '2026-05-06T00:00:02.000Z',
          errorCode: testCase.status === 'failed' ? 'ERR_RUN' : undefined,
          errorMessage: testCase.status === 'failed' ? 'Run failed' : undefined,
          usage: testCase.status === 'completed' ? { input_tokens: 1, output_tokens: 2, tool_calls: 3 } : undefined
        })
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, testCase.type);
      assert.equal(events[0]?.data?.status, testCase.status);
      assert.equal(events[0]?.data?.endedAt, '2026-05-06T00:00:02.000Z');
    }
  });

  it('does not add a Kubernetes cluster alias for non-Kubernetes run targets', () => {
    const events: WebhookEventInput[] = [];
    webhooks.emit = (input) => {
      events.push(input);
    };

    emitRunStatusTransition(
      createRun('dispatching', {
        targetId: 'vm-1',
        targetType: 'virtual_machine',
        clusterId: 'vm-1'
      }),
      createRun('running', {
        targetId: 'vm-1',
        targetType: 'virtual_machine',
        clusterId: 'vm-1',
        startedAt: '2026-05-06T00:00:01.000Z'
      })
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.clusterId, undefined);
    assert.equal(events[0]?.targetId, 'vm-1');
    assert.equal(events[0]?.targetType, 'virtual_machine');
  });

  it('does not emit when there is no next run or the run stays within terminal states', () => {
    const events: WebhookEventInput[] = [];
    webhooks.emit = (input) => {
      events.push(input);
    };

    emitRunStatusTransition(createRun('running'), null);
    emitRunStatusTransition(createRun('failed'), createRun('cancelled'));

    assert.deepEqual(events, []);
  });
});
