import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../../src/config.js';
import {
  effectiveWorkflowRuntimePolicy,
  manualWorkflowCapabilityPolicy,
  manualWorkflowRequiredPermissions,
  withEffectiveWorkflowRuntimePolicy
} from '../../src/services/workflow-runtime-policy.js';

describe('workflow runtime policy', () => {
  it('derives effective timing only from deployment configuration', () => {
    const effective = effectiveWorkflowRuntimePolicy();
    assert.deepEqual(effective, {
      maxRuntimeSeconds: Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)),
      retentionDays: config.TARGET_CHAT_REPORT_RETENTION_DAYS
    });
    assert.deepEqual(withEffectiveWorkflowRuntimePolicy({
      mode: 'read_write',
      restrictionMode: 'restrict',
      semanticCapabilityIds: ['target.remediation.write'],
      contextGrants: [],
      maxRuntimeSeconds: 1,
      retentionDays: 365,
      approvalRequirements: ['Approve writes']
    }), {
      mode: 'read_write',
      restrictionMode: 'restrict',
      semanticCapabilityIds: ['target.remediation.write'],
      contextGrants: [],
      ...effective,
      approvalRequirements: ['Approve writes']
    });
  });

  it('owns safe defaults for manually created workflows', () => {
    assert.deepEqual(manualWorkflowCapabilityPolicy(), {
      mode: 'read_only',
      restrictionMode: 'inherit',
      semanticCapabilityIds: [],
      contextGrants: ['workspace_metadata'],
      ...effectiveWorkflowRuntimePolicy(),
      approvalRequirements: []
    });
    assert.deepEqual(manualWorkflowRequiredPermissions(), ['read_workspace_data']);
  });
});
