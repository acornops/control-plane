import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeNextWorkflowScheduleRunAt,
  computeUpcomingWorkflowScheduleRuns,
  summarizeWorkflowScheduleCron,
  validateWorkflowScheduleCron
} from '../src/store/repository-workflow-schedules.js';

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

test('restricted month days and weekdays match either day, not only their intersection', () => {
  assert.equal(computeNextWorkflowScheduleRunAt('0 0 13 * 5', new Date('2026-09-01T00:00:00Z')),
    '2026-09-04T00:00:00.000Z');
});

test('leading-star day fields intersect both day constraints, including steps and lists', () => {
  for (const [expression, expected] of [
    ['0 0 */2 * 1', '2026-01-05T00:00:00.000Z'],
    ['0 0 13 * */2', '2026-01-13T00:00:00.000Z'],
    ['0 0 */2,2 * 1', '2026-01-05T00:00:00.000Z'],
    ['0 0 */2 * 2-4', '2026-01-07T00:00:00.000Z'],
    ['0 0 5,13 * */2', '2026-01-13T00:00:00.000Z'],
    ['0 0 */2 * */2', '2026-01-03T00:00:00.000Z']
  ]) {
    assert.equal(computeNextWorkflowScheduleRunAt(expression, new Date('2026-01-01T00:00:00Z')), expected, expression);
  }
});

test('restricted ranges and lists retain OR, including an impossible month-day branch', () => {
  for (const expression of ['0 0 13,15 * 5', '0 0 13-15 * 5']) {
    assert.equal(computeNextWorkflowScheduleRunAt(expression, new Date('2026-01-01T00:00:00Z')),
      '2026-01-02T00:00:00.000Z');
  }
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('0 0 31 2 5', 'UTC', 3,
    new Date('2026-01-01T00:00:00Z')), [
    '2026-02-06T00:00:00.000Z', '2026-02-13T00:00:00.000Z', '2026-02-20T00:00:00.000Z'
  ]);
});

test('stepped day intersections use local dates and retain DST handling', () => {
  assert.equal(computeNextWorkflowScheduleRunAt('0 0 */2 * 1',
    new Date('2026-01-01T00:00:00Z'), 'Asia/Singapore'), '2026-01-04T16:00:00.000Z');
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('30 2 */1 * 0', 'America/New_York', 2,
    new Date('2026-03-07T08:00:00Z')), ['2026-03-08T07:30:00.000Z', '2026-03-15T06:30:00.000Z']);
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('30 1 */1 * 0', 'America/New_York', 2,
    new Date('2026-10-31T08:00:00Z')), ['2026-11-01T05:30:00.000Z', '2026-11-08T06:30:00.000Z']);
});

test('leap-day weekday intersections cross the forty-year non-leap-century gap', () => {
  assert.equal(computeNextWorkflowScheduleRunAt('0 0 29 2 */7', new Date('2088-03-01T00:00:00Z')),
    '2128-02-29T00:00:00.000Z');
});

test('dense impossible intersections terminate without scanning every candidate minute', () => {
  const start = performance.now();
  assert.equal(validateWorkflowScheduleCron('* * 31 2 */2'), false);
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('* * 31 2 */2', 'America/New_York', 5,
    new Date('2026-01-01T00:00:00Z')), []);
  assert.ok(performance.now() - start < 1_000, 'an impossible intersection should fail within one second');
});

test('leap-day schedules remain runnable beyond the next year', () => {
  assert.equal(computeNextWorkflowScheduleRunAt('0 0 29 2 *', new Date('2026-09-05T00:00:00Z')),
    '2028-02-29T00:00:00.000Z');
});

test('numeric start/step fields advance from the start instead of ignoring the step', () => {
  assert.equal(computeNextWorkflowScheduleRunAt('5/15 * * * *', new Date('2026-09-05T00:05:00Z')),
    '2026-09-05T00:20:00.000Z');
});

test('invalid and impossible dates are rejected within the numeric five-field contract', () => {
  for (const expression of ['*/0 * * * *', '5-1 * * * *', '? * * * *', '0 0 31 2 *',
    '0 0 * JAN *', '* * * * * *', '1,,2 * * * *', '-1 * * * *', '1.5 * * * *',
    '*/9007199254740992 * * * *']) {
    assert.equal(validateWorkflowScheduleCron(expression), false, expression);
  }
});

test('complex cadence summaries do not format cron tokens as a clock time', () => {
  assert.equal(summarizeWorkflowScheduleCron('*/5 * * * *', 'UTC'), 'Cron */5 * * * * (UTC)');
});

test('monthly non-UTC previews complete without a multi-second event-loop stall', () => {
  const start = performance.now();
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('0 9 1 * *', 'Asia/Singapore', 5,
    new Date('2026-09-05T00:00:00Z')), [
    '2026-10-01T01:00:00.000Z', '2026-11-01T01:00:00.000Z',
    '2026-12-01T01:00:00.000Z', '2027-01-01T01:00:00.000Z', '2027-02-01T01:00:00.000Z'
  ]);
  assert.ok(performance.now() - start < 1_000, 'five monthly occurrences should take less than one second');
});

test('spring-forward cadence moves the missing hour forward and resumes local time', () => {
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('30 2 * * *', 'America/New_York', 3,
    new Date('2026-03-07T08:00:00Z')), [
    '2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'
  ]);
});

test('fall-back cadence runs once in the repeated hour and resumes local time', () => {
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('30 1 * * *', 'America/New_York', 3,
    new Date('2026-10-31T08:00:00Z')), [
    '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z'
  ]);
});

test('leap-day iteration crosses a non-leap century and returns successive leap years', () => {
  assert.deepEqual(computeUpcomingWorkflowScheduleRuns('0 0 29 2 *', 'UTC', 3,
    new Date('2096-03-01T00:00:00Z')), [
    '2104-02-29T00:00:00.000Z', '2108-02-29T00:00:00.000Z', '2112-02-29T00:00:00.000Z'
  ]);
});
