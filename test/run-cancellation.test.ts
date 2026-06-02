import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { terminalizeRunCancellation } from '../src/controllers/run-cancellation.js';
import { repo } from '../src/store/repository.js';
import { runtime } from '../src/store/runtime.js';
import { createRun, restoreControllerRegressionState } from './helpers/controller-regression-fixtures.js';

const originalAppendRunEvents = repo.appendRunEvents;
const originalGetRunEvents = repo.getRunEvents;
const originalUpdateRun = repo.updateRun;

afterEach(() => {
  restoreControllerRegressionState();
  repo.appendRunEvents = originalAppendRunEvents;
  repo.getRunEvents = originalGetRunEvents;
  repo.updateRun = originalUpdateRun;
  runtime.clearRunEvents('run-1');
});

describe('run cancellation terminalization', () => {
  it('does not emit run_cancelled when the run update fails', async () => {
    let appended = false;
    repo.updateRun = async () => null;
    repo.appendRunEvents = async () => {
      appended = true;
      return [];
    };

    const result = await terminalizeRunCancellation(createRun({ status: 'running' }));

    assert.equal(result, null);
    assert.equal(appended, false);
    assert.deepEqual(runtime.getRunEvents('run-1'), []);
  });

  it('does not append a duplicate run_cancelled event when one already exists', async () => {
    let appended = false;
    const existingEvent = {
      schema_version: 1,
      run_id: 'run-1',
      seq: 4,
      ts: '2026-05-24T00:00:00.000Z',
      type: 'run_cancelled',
      payload: { reason: 'user_cancelled' }
    } as const;
    repo.updateRun = async () => createRun({ status: 'cancelled' });
    repo.getRunEvents = async () => [existingEvent];
    runtime.appendRunEvents('run-1', [existingEvent]);
    repo.appendRunEvents = async () => {
      appended = true;
      return [];
    };

    const result = await terminalizeRunCancellation(createRun({ status: 'running' }));

    assert.equal(result?.status, 'cancelled');
    assert.equal(appended, false);
  });
});
