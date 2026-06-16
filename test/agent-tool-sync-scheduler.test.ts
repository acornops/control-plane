import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  resetBuiltInToolSyncSchedulerStateForTests,
  scheduleBuiltInToolSync,
  setBuiltInToolSyncRetryDelaysForTests,
  setBuiltInToolSyncRunnerForTests
} from '../src/agent/tool-sync-scheduler.js';
import type { BuiltInToolSyncResult } from '../src/services/target-built-in-tool-sync.js';

function result(patch: Partial<BuiltInToolSyncResult>): BuiltInToolSyncResult {
  return {
    ok: true,
    workspaceId: 'workspace-1',
    targetId: 'cluster-1',
    targetType: 'kubernetes',
    discoveredToolCount: 1,
    registeredToolCount: 1,
    addedTools: [],
    removedTools: [],
    ...patch
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for scheduler condition');
}

afterEach(() => {
  resetBuiltInToolSyncSchedulerStateForTests();
});

describe('built-in tool sync scheduler', () => {
  it('retries handshake-triggered syncs until tools are registered in llm-gateway', async () => {
    const outcomes = [
      result({ ok: false, discoveredToolCount: 0, registeredToolCount: 0, error: 'gateway unavailable' }),
      result({ discoveredToolCount: 0, registeredToolCount: 0 }),
      result({ discoveredToolCount: 1, registeredToolCount: 0 }),
      result({ discoveredToolCount: 1, registeredToolCount: 1 })
    ];
    let calls = 0;
    setBuiltInToolSyncRetryDelaysForTests([0, 1, 1, 1]);
    setBuiltInToolSyncRunnerForTests(async () => outcomes[calls++] ?? result({}));

    scheduleBuiltInToolSync('workspace-1', 'cluster-1', 'kubernetes');

    await waitFor(() => calls === 4);
    assert.equal(calls, 4);
  });

  it('coalesces duplicate handshake-triggered syncs for the same target', async () => {
    let calls = 0;
    setBuiltInToolSyncRetryDelaysForTests([5]);
    setBuiltInToolSyncRunnerForTests(async () => {
      calls += 1;
      return result({});
    });

    scheduleBuiltInToolSync('workspace-1', 'cluster-1', 'kubernetes');
    scheduleBuiltInToolSync('workspace-1', 'cluster-1', 'kubernetes');

    await waitFor(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
  });
});
