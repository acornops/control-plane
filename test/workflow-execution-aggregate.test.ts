import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveWorkflowExecutionAggregateStatus } from '../src/store/repository-automation-approvals.js';

describe('Workflow execution aggregate approval status', () => {
  it('propagates root and required-child approval waits', () => {
    assert.equal(deriveWorkflowExecutionAggregateStatus('waiting_for_approval', []), 'waiting_for_approval');
    assert.equal(deriveWorkflowExecutionAggregateStatus('running', [
      { status: 'waiting_for_approval', required: true }
    ]), 'waiting_for_approval');
  });

  it('propagates required-child uncertain writes without terminalizing the execution', () => {
    assert.equal(deriveWorkflowExecutionAggregateStatus('running', [
      { status: 'needs_review', required: true }
    ]), 'needs_review');
  });

  it('keeps optional-child waits and review states local', () => {
    assert.equal(deriveWorkflowExecutionAggregateStatus('running', [
      { status: 'waiting_for_approval', required: false },
      { status: 'needs_review', required: false }
    ]), 'running');
  });

  it('leaves terminal status under root ownership', () => {
    assert.equal(deriveWorkflowExecutionAggregateStatus('completed', [
      { status: 'needs_review', required: true }
    ]), 'completed');
    assert.equal(deriveWorkflowExecutionAggregateStatus('running', [
      { status: 'failed', required: true }
    ]), 'running');
  });
});
