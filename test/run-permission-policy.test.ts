import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  legacyWriteConfirmationRequired,
  narrowRunPermissionModes,
  permissionModeAllowsAccess,
  resolveEffectiveRunPermissionMode
} from '../src/services/run-permission-policy.js';

describe('run permission policy', () => {
  it('uses the most restrictive policy regardless of input order', () => {
    assert.equal(
      narrowRunPermissionModes('auto_allowed_changes', 'read_only', 'ask_before_changes'),
      'read_only'
    );
    assert.equal(
      narrowRunPermissionModes('ask_before_changes', 'auto_allowed_changes'),
      'ask_before_changes'
    );
  });

  it('lets run access narrow a target policy but never widen it', () => {
    assert.equal(resolveEffectiveRunPermissionMode({
      accessMode: 'read_only',
      policies: ['auto_allowed_changes']
    }), 'read_only');
    assert.equal(resolveEffectiveRunPermissionMode({
      accessMode: 'read_write',
      policies: ['read_only']
    }), 'read_only');
    assert.equal(permissionModeAllowsAccess('read_only', 'read_write'), false);
    assert.equal(permissionModeAllowsAccess('read_only', 'read_only'), true);
  });

  it('allows a run to require approval without weakening stricter policies', () => {
    assert.equal(resolveEffectiveRunPermissionMode({
      accessMode: 'read_write',
      policies: ['auto_allowed_changes'],
      forceApproval: true
    }), 'ask_before_changes');
    assert.equal(resolveEffectiveRunPermissionMode({
      accessMode: 'read_write',
      policies: ['read_only'],
      forceApproval: true
    }), 'read_only');
  });

  it('projects read-only conservatively for legacy confirmation clients', () => {
    assert.equal(legacyWriteConfirmationRequired('read_only'), true);
    assert.equal(legacyWriteConfirmationRequired('ask_before_changes'), true);
    assert.equal(legacyWriteConfirmationRequired('auto_allowed_changes'), false);
  });
});
