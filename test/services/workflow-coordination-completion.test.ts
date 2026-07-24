import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundedCoordinatorChildResult } from '../../src/controllers/internal-delegation-controller.js';
import { coordinationCompletionFailure } from '../../src/services/workflow-coordination-completion.js';

describe('coordinator completion gate', () => {
  it('requires at least one delegation and waits for every child to become terminal', () => {
    assert.equal(coordinationCompletionFailure([])?.code, 'NO_DELEGATION_CREATED');
    assert.equal(coordinationCompletionFailure([
      { id: 'child-1', status: 'running', required: true }
    ])?.code, 'DELEGATIONS_STILL_ACTIVE');
  });

  it('rejects every unsuccessful required-child terminal state', () => {
    for (const status of ['failed', 'cancelled', 'needs_review']) {
      assert.equal(coordinationCompletionFailure([
        { id: 'child-required', status, required: true },
        { id: 'child-success', status: 'completed', required: false }
      ])?.code, 'REQUIRED_DELEGATION_FAILED');
    }
  });

  it('requires at least one successful specialist', () => {
    assert.equal(coordinationCompletionFailure([
      { id: 'child-optional', status: 'failed', required: false }
    ])?.code, 'NO_SPECIALIST_SUCCEEDED');
  });

  it('allows optional failure when another child succeeds', () => {
    assert.equal(coordinationCompletionFailure([
      { id: 'child-optional', status: 'failed', required: false },
      { id: 'child-success', status: 'completed', required: true }
    ]), undefined);
  });

  it('bounds specialist output before returning it to the coordinator', () => {
    const result = boundedCoordinatorChildResult({
      content: 'x'.repeat(20_000),
      format: 'markdown'
    });
    assert.equal(result?.content.length, 12_000);
    assert.equal(result?.format, 'markdown');
  });
});
