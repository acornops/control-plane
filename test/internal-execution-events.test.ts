import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldReconcileFailedRunCommit } from '../src/controllers/internal-execution-events.js';

test('reconciles only matching failed commits whose terminal details are missing', () => {
  assert.equal(shouldReconcileFailedRunCommit('failed', 'failed', false), true);
  assert.equal(shouldReconcileFailedRunCommit('failed', 'completed', false), false);
  assert.equal(shouldReconcileFailedRunCommit('cancelled', 'failed', false), false);
  assert.equal(shouldReconcileFailedRunCommit('running', 'failed', false), false);
  assert.equal(shouldReconcileFailedRunCommit('failed', 'failed', true), false);
});
