import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { getTargetChatActivity, streamTargetChatActivity } from '../src/controllers/target-chat-activity-stream-controller.js';
import { targetChatActivityStreamKey } from '../src/services/target-chat-activity-events.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import type { TargetChatActivityEvent } from '../src/types/domain.js';
import {
  callController,
  createRequest,
  createResponse,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function createStreamRequest(params: Record<string, string>, query: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), {
    params,
    query,
    headers: {},
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    }
  });
}

function createStreamResponse(writes: string[]) {
  return {
    statusCode: 200,
    headers: undefined as Record<string, string> | undefined,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    flushHeaders() {},
    write(chunk: string) {
      writes.push(chunk);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      writes.push(JSON.stringify(payload));
      return this;
    }
  };
}

describe('target chat activity controller', () => {
  it('returns recent target chat activity for readable target sessions', async () => {
    installWorkspace('viewer');
    let capturedWindowSeconds = 0;
    repo.listRecentTargetChatActivity = async (_workspaceId: string, targetId: string, windowSeconds: number) => {
      capturedWindowSeconds = windowSeconds;
      return [
        {
          sessionId: 'session-1',
          title: 'Session',
          createdBy: 'user-1',
          createdByUser: { id: 'user-1', displayName: 'User One' },
          lastActivityAt: '2026-05-24T00:01:00.000Z',
          lastRunId: 'run-1',
          lastRunStatus: 'waiting_for_approval',
          activeRun: {
            runId: 'run-1',
            status: 'waiting_for_approval',
            toolAccessMode: 'read_write',
            requestedAt: '2026-05-24T00:00:30.000Z'
          },
          hasActiveRun: true,
          hasRecentWriteCapableRun: true,
          latestToolAccessMode: 'read_write'
        }
      ];
    };

    const allowed = await callController(
      getTargetChatActivity,
      createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' })
    );

    assert.equal(allowed.statusCode, 200);
    assert.equal(capturedWindowSeconds, 300);
    assert.equal((allowed.body as { targetName: string }).targetName, 'cluster');
    assert.equal((allowed.body as { recentActivity: unknown[] }).recentActivity.length, 1);
  });

  it('clamps target chat activity windows to the supported range', async () => {
    installWorkspace('viewer');
    let capturedWindowSeconds = 0;
    repo.listRecentTargetChatActivity = async (_workspaceId: string, _targetId: string, windowSeconds: number) => {
      capturedWindowSeconds = windowSeconds;
      return [];
    };

    const request = createRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' });
    request.query = { windowSeconds: '99999' };
    const allowed = await callController(getTargetChatActivity, request);

    assert.equal(allowed.statusCode, 200);
    assert.equal(capturedWindowSeconds, 3600);
    assert.equal((allowed.body as { windowSeconds: number }).windowSeconds, 3600);
  });

  it('replays target chat activity stream events after the requested cursor', async () => {
    installWorkspace('viewer');
    let capturedAfterId: string | undefined;
    repo.listTargetChatActivityEvents = async (_workspaceId, _targetId, options) => {
      capturedAfterId = options?.afterId;
      return [
        {
          id: '43',
          workspaceId: 'workspace-1',
          targetId: 'cluster-1',
          targetType: 'kubernetes',
          sessionId: 'session-1',
          runId: 'run-1',
          messageId: 'message-1',
          type: 'assistant_message.committed',
          payload: { runId: 'run-1' },
          createdAt: '2026-05-24T00:01:00.000Z'
        } satisfies TargetChatActivityEvent
      ];
    };
    const req = createStreamRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' }, { after: '42' });
    const writes: string[] = [];
    const res = createStreamResponse(writes);

    await streamTargetChatActivity(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });
    req.emit('close');

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers?.['Content-Type'], 'text/event-stream');
    assert.equal(capturedAfterId, '42');
    assert(writes.includes('id: 43\n'));
    assert(writes.includes('event: chat_activity\n'));
    assert(writes.some((chunk) => chunk.includes('"type":"assistant_message.committed"')));
  });

  it('replays all persisted target chat activity pages before live fanout', async () => {
    installWorkspace('viewer');
    const events = Array.from({ length: 501 }, (_, index) => ({
      id: String(43 + index),
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: `message-${index}`,
      type: 'run.status_changed',
      payload: { runId: 'run-1', status: 'running' },
      createdAt: '2026-05-24T00:01:00.000Z'
    } satisfies TargetChatActivityEvent));
    const capturedAfterIds: string[] = [];
    repo.listTargetChatActivityEvents = async (_workspaceId, _targetId, options) => {
      capturedAfterIds.push(options?.afterId || '0');
      const afterId = BigInt(options?.afterId || '0');
      return events
        .filter((event) => BigInt(event.id) > afterId)
        .slice(0, options?.limit || 500);
    };
    const req = createStreamRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' }, { after: '42' });
    const writes: string[] = [];
    const res = createStreamResponse(writes);

    await streamTargetChatActivity(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });
    req.emit('close');

    assert.deepEqual(capturedAfterIds, ['42', '542']);
    assert(writes.includes('id: 43\n'));
    assert(writes.includes('id: 543\n'));
  });

  it('deduplicates repeated live target chat activity stream events', async () => {
    installWorkspace('viewer');
    repo.listTargetChatActivityEvents = async () => [];
    const req = createStreamRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' }, { after: '42' });
    const writes: string[] = [];
    const res = createStreamResponse(writes);

    await streamTargetChatActivity(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    const event = {
      id: '44',
      workspaceId: 'workspace-1',
      targetId: 'cluster-1',
      targetType: 'kubernetes',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1',
      type: 'run.status_changed',
      payload: { runId: 'run-1', status: 'completed' },
      createdAt: '2026-05-24T00:01:00.000Z'
    } satisfies TargetChatActivityEvent;
    const key = targetChatActivityStreamKey('workspace-1', 'cluster-1');
    runtime.targetChatActivityStreams.emit(key, { event });
    runtime.targetChatActivityStreams.emit(key, { event });
    req.emit('close');

    assert.equal(writes.filter((chunk) => chunk.includes('"id":"44"')).length, 1);
  });

  it('does not open the target chat activity stream when replay fails', async () => {
    installWorkspace('viewer');
    const replayError = new Error('replay unavailable');
    repo.listTargetChatActivityEvents = async () => {
      throw replayError;
    };
    const key = targetChatActivityStreamKey('workspace-1', 'cluster-1');
    const req = createStreamRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' }, { after: '42' });
    const writes: string[] = [];
    const res = createStreamResponse(writes);
    let capturedError: unknown;

    await streamTargetChatActivity(req as never, res as never, (err?: unknown) => {
      capturedError = err;
    });

    assert.equal(capturedError, replayError);
    assert.equal(res.headers, undefined);
    assert.equal(writes.length, 0);
    assert.equal(runtime.targetChatActivityStreams.listenerCount(key), 0);
  });

  it('requires target read access before opening the target chat activity stream', async () => {
    installWorkspace(null);
    let replayAttempted = false;
    repo.listTargetChatActivityEvents = async () => {
      replayAttempted = true;
      return [];
    };
    const req = createStreamRequest({ workspaceId: 'workspace-1', targetId: 'cluster-1' });
    const res = createResponse();

    await streamTargetChatActivity(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.equal(replayAttempted, false);
  });
});
