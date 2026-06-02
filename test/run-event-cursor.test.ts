import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { requireServiceToken } from '../src/auth/middleware.js';
import { config } from '../src/config.js';
import { getRunEventCursor } from '../src/controllers/internal-execution-controller.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import type { Run } from '../src/types/domain.js';

const originalGetRun = repo.getRun;
const originalGetLatestRunEventSeq = repo.getLatestRunEventSeq;
const originalPersistRunEvents = config.PERSIST_RUN_EVENTS;

afterEach(() => {
  repo.getRun = originalGetRun;
  repo.getLatestRunEventSeq = originalGetLatestRunEventSeq;
  config.PERSIST_RUN_EVENTS = originalPersistRunEvents;
  runtime.clearRunEvents('run-1');
});

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    toolAccessMode: 'read_write',
    status: 'running',
    requestedAt: '2026-05-06T00:00:00.000Z',
    ...overrides
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe('internal run event cursor', () => {
  it('returns zero when a run has no persisted events', async () => {
    repo.getRun = async () => createRun();
    repo.getLatestRunEventSeq = async () => 0;
    const res = createResponse();

    await getRunEventCursor({ params: { runId: 'run-1' } } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { latestSeq: 0 });
  });

  it('returns the latest persisted run event sequence', async () => {
    config.PERSIST_RUN_EVENTS = true;
    repo.getRun = async () => createRun();
    repo.getLatestRunEventSeq = async () => 16;
    const res = createResponse();

    await getRunEventCursor({ params: { runId: 'run-1' } } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { latestSeq: 16 });
  });

  it('returns the latest runtime replay sequence when event persistence is disabled', async () => {
    config.PERSIST_RUN_EVENTS = false;
    repo.getRun = async () => createRun();
    repo.getLatestRunEventSeq = async () => {
      throw new Error('persisted cursor should not be read');
    };
    runtime.appendRunEvents('run-1', [
      {
        schema_version: 1,
        run_id: 'run-1',
        seq: 16,
        ts: '2026-05-06T00:00:01.000Z',
        type: 'tool_approval_requested',
        payload: {}
      }
    ]);
    const res = createResponse();

    await getRunEventCursor({ params: { runId: 'run-1' } } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { latestSeq: 16 });
  });

  it('returns not found for a missing run', async () => {
    repo.getRun = async () => null;
    const res = createResponse();

    await getRunEventCursor({ params: { runId: 'missing-run' } } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, 'NOT_FOUND');
  });

  it('requires the service token middleware before route handlers run', () => {
    const res = createResponse();
    let called = false;

    requireServiceToken(
      { header: () => `Bearer ${config.ORCH_SERVICE_TOKEN}` } as never,
      res as never,
      () => {
        called = true;
      }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(called, true);

    const rejected = createResponse();
    requireServiceToken({ header: () => '' } as never, rejected as never, () => {
      throw new Error('unexpected middleware pass');
    });

    assert.equal(rejected.statusCode, 401);
    assert.deepEqual((rejected.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  });
});
