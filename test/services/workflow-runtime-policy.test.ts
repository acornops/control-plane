import assert from 'node:assert/strict';
import { it } from 'node:test';
import { config } from '../../src/config.js';
import { effectiveWorkflowRuntimePolicy } from '../../src/services/workflow-runtime-policy.js';

it('derives Workflow timing only from deployment configuration', () => {
  assert.deepEqual(effectiveWorkflowRuntimePolicy(), {
    maxRuntimeSeconds: Math.max(1, Math.floor(config.ASSISTANT_MAX_RUNTIME_MS / 1000)),
    retentionDays: config.GENERATED_DOCUMENT_RETENTION_DAYS
  });
});
