import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { dispatchRunToExecutionEngine } from '../src/services/execution-engine-client.js';
import type { Run } from '../src/types/domain.js';

afterEach(() => mock.restoreAll());
const run = { id: 'run', workspaceId: 'workspace', conversationKind: 'target_chat', targetId: 'target', targetType: 'kubernetes' } as Run;
const draining = { error: { code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started' } };

test('dispatch retries only trusted preadmission drain and preserves exact run identity', async () => {
  const calls: RequestInit[] = [];
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    return calls.length === 1 ? new Response(JSON.stringify(draining), { status: 503 }) : new Response('{}', { status: 202 });
  });
  await dispatchRunToExecutionEngine(run);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].redirect, 'error');
});

for (const response of [
  { status: 500, body: draining },
  { status: 503, body: { error: { ...draining.error, outcome: 'unknown' } } },
  { status: 401, body: draining }
]) {
  test(`dispatch does not replay ${response.status} ${response.body.error.outcome}`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(response.body), { status: response.status }); });
    await assert.rejects(dispatchRunToExecutionEngine(run));
    assert.equal(calls, 1);
  });
}

for (const message of [undefined, '', 'upstream unavailable']) {
  test(`dispatch does not replay an incomplete drain classification (message ${JSON.stringify(message)})`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { ...draining.error, message } }), { status: 503 })
        : new Response('{}', { status: 202 });
    });
    await assert.rejects(dispatchRunToExecutionEngine(run), /Execution Engine start failed \(503\)/);
    assert.equal(calls, 1);
  });
}
