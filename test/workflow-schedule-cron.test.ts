import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNextWorkflowScheduleRunAt } from '../src/store/repository-workflow-schedules.js';

test('workflow schedules compute the next due time in the stored timezone', () => {
  assert.equal(
    computeNextWorkflowScheduleRunAt(
      '0 9 * * *',
      new Date('2026-01-01T00:30:00.000Z'),
      'Asia/Singapore'
    ),
    '2026-01-01T01:00:00.000Z'
  );
});
