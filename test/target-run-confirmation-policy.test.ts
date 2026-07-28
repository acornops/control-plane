import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveTargetRunConfirmationPolicy } from '../src/services/target-run-confirmation-policy.js';

describe('target run confirmation policy', () => {
  it('preserves the target confirmation policy for ordinary manual runs', () => {
    assert.deepEqual(
      resolveTargetRunConfirmationPolicy({
        toolAccessMode: 'read_write',
        confirmationRequiredForWriteOverride: undefined
      }, false),
      {
        confirmationRequiredForWrite: false,
        permissionMode: 'auto_allowed_changes'
      }
    );
  });

  it('allows a run to force approval without weakening the target ceiling', () => {
    assert.deepEqual(
      resolveTargetRunConfirmationPolicy({
        toolAccessMode: 'read_write',
        confirmationRequiredForWriteOverride: true
      }, false),
      {
        confirmationRequiredForWrite: true,
        permissionMode: 'ask_before_changes'
      }
    );
    assert.deepEqual(
      resolveTargetRunConfirmationPolicy({
        toolAccessMode: 'read_write',
        confirmationRequiredForWriteOverride: false
      }, true),
      {
        confirmationRequiredForWrite: true,
        permissionMode: 'ask_before_changes'
      }
    );
  });

  it('never exposes write permission mode to a read-only run', () => {
    assert.equal(
      resolveTargetRunConfirmationPolicy({
        toolAccessMode: 'read_only',
        confirmationRequiredForWriteOverride: false
      }, false).permissionMode,
      'read_only'
    );
  });
});
