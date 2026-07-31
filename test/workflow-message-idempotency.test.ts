import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowMessageRequestFingerprint } from '../src/controllers/workflow-message-idempotency.js';

test('parameterless workflow launches have a stable retry fingerprint', () => {
  assert.equal(
    workflowMessageRequestFingerprint({ kind: 'launch' }),
    workflowMessageRequestFingerprint({ kind: 'launch' })
  );
});

test('workflow follow-up fingerprints still include content', () => {
  assert.notEqual(
    workflowMessageRequestFingerprint({ kind: 'follow_up', content: 'first' }),
    workflowMessageRequestFingerprint({ kind: 'follow_up', content: 'second' })
  );
});
