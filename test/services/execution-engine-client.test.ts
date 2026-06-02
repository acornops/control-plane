import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../../src/config.js';
import { logger } from '../../src/logger.js';
import {
  cancelRunInExecutionEngine,
  dispatchRunToExecutionEngine
} from '../../src/services/execution-engine-client.js';
import type { Run } from '../../src/types/domain.js';

const mutableConfig = config as typeof config & {
  EXECUTION_ENGINE_BASE_URL: string;
  EXECUTION_ENGINE_DISPATCH_TOKEN: string;
  EXECUTION_ENGINE_TIMEOUT_MS: number;
};

const originalExecutionEngineBaseUrl = config.EXECUTION_ENGINE_BASE_URL;
const originalExecutionEngineDispatchToken = config.EXECUTION_ENGINE_DISPATCH_TOKEN;
const originalExecutionEngineTimeoutMs = config.EXECUTION_ENGINE_TIMEOUT_MS;

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    clusterId: 'cluster-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    toolAccessMode: 'read_only',
    status: 'queued',
    requestedAt: '2026-05-25T00:00:00.000Z',
    ...overrides
  };
}

afterEach(() => {
  mutableConfig.EXECUTION_ENGINE_BASE_URL = originalExecutionEngineBaseUrl;
  mutableConfig.EXECUTION_ENGINE_DISPATCH_TOKEN = originalExecutionEngineDispatchToken;
  mutableConfig.EXECUTION_ENGINE_TIMEOUT_MS = originalExecutionEngineTimeoutMs;
  mock.restoreAll();
});

describe('execution engine client', () => {
  it('dispatches runs with the expected payload and authorization header', async () => {
    mutableConfig.EXECUTION_ENGINE_BASE_URL = 'https://engine.example.com';
    mutableConfig.EXECUTION_ENGINE_DISPATCH_TOKEN = 'dispatch-token';

    let fetchCall:
      | {
          url: string;
          init?: RequestInit;
        }
      | undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      fetchCall = {
        url: input instanceof URL ? input.toString() : String(input),
        init
      };
      return new Response(null, { status: 202 });
    });

    await dispatchRunToExecutionEngine(createRun());

    assert.ok(fetchCall);
    assert.equal(fetchCall.url, 'https://engine.example.com/api/v1/runs');
    assert.equal(fetchCall.init?.method, 'POST');
    const headers = new Headers(fetchCall.init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorization'), 'Bearer dispatch-token');
    assert.deepEqual(JSON.parse(String(fetchCall.init?.body)), {
      contract_version: 1,
      run_id: 'run-1',
      workspace_id: 'ws-1',
      target_id: 'cluster-1',
      target_type: 'kubernetes',
      session_id: 'session-1',
      message_id: 'message-1',
      requested_at: '2026-05-25T00:00:00.000Z'
    });
  });

  it('aborts timed-out dispatch requests and logs the failure', async () => {
    mutableConfig.EXECUTION_ENGINE_TIMEOUT_MS = 5;

    const loggedErrors: unknown[] = [];
    mock.method(logger, 'error', (...args: unknown[]) => {
      loggedErrors.push(args);
    });
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const fallback = setTimeout(() => {
        reject(new Error('dispatch timeout test did not abort'));
      }, 100);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(fallback);
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    }));

    await assert.rejects(
      dispatchRunToExecutionEngine(createRun()),
      /aborted/
    );
    assert.equal(loggedErrors.length, 1);
    assert.equal((loggedErrors[0] as [Record<string, unknown>, string])[0].runId, 'run-1');
  });

  it('posts run cancellations to the execution engine', async () => {
    mutableConfig.EXECUTION_ENGINE_BASE_URL = 'https://engine.example.com';
    mutableConfig.EXECUTION_ENGINE_DISPATCH_TOKEN = 'dispatch-token';

    let fetchCall:
      | {
          url: string;
          init?: RequestInit;
        }
      | undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      fetchCall = {
        url: input instanceof URL ? input.toString() : String(input),
        init
      };
      return new Response(null, { status: 202 });
    });

    await cancelRunInExecutionEngine('run-9');

    assert.ok(fetchCall);
    assert.equal(fetchCall.url, 'https://engine.example.com/api/v1/runs/run-9/cancel');
    assert.equal(fetchCall.init?.method, 'POST');
    const headers = new Headers(fetchCall.init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorization'), 'Bearer dispatch-token');
  });

  it('logs and rethrows non-successful cancellation responses', async () => {
    const loggedErrors: unknown[] = [];
    mock.method(logger, 'error', (...args: unknown[]) => {
      loggedErrors.push(args);
    });
    mock.method(globalThis, 'fetch', async () => new Response('conflict', { status: 409 }));

    await assert.rejects(
      cancelRunInExecutionEngine('run-42'),
      /Execution Engine cancel failed \(409\): conflict/
    );
    assert.equal(loggedErrors.length, 1);
    assert.equal((loggedErrors[0] as [Record<string, unknown>, string])[0].runId, 'run-42');
  });
});
