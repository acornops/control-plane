import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constantTimeSignatureEqual,
  validateWorkflowWebhookContextGrants
} from '../src/controllers/workflow-webhooks-controller.js';
import {
  WORKFLOW_WEBHOOK_CREATE_FIELDS,
  parseContextGrantList,
  unexpectedBodyField
} from '../src/controllers/workflow-webhook-validation.js';
import { signWebhookPayload } from '../src/utils/crypto.js';

describe('workflow webhook validation', () => {
  it('requires exactly the workflow context grants', () => {
    assert.equal(validateWorkflowWebhookContextGrants(
      ['workspace.summary'],
      ['workspace.summary']
    ), null);
    assert.match(validateWorkflowWebhookContextGrants(
      ['workspace.summary'],
      []
    ) || '', /Approve the workspace.summary/);
    assert.match(validateWorkflowWebhookContextGrants(
      ['workspace.summary'],
      ['workspace.summary', 'target.secrets']
    ) || '', /target.secrets is not used/);
  });

  it('rejects malformed grant lists and unknown mutation fields', () => {
    assert.deepEqual(parseContextGrantList(undefined), []);
    assert.deepEqual(parseContextGrantList(['workspace.summary']), ['workspace.summary']);
    assert.equal(parseContextGrantList('workspace.summary'), null);
    assert.equal(parseContextGrantList(['workspace.summary', 'workspace.summary']), null);
    assert.equal(parseContextGrantList(['workspace.summary', 42]), null);
    assert.equal(
      unexpectedBodyField({ workflowId: 'workflow-1', principal: { id: 'user-2' } }, WORKFLOW_WEBHOOK_CREATE_FIELDS),
      'principal'
    );
  });

  it('compares supported HMAC signature encodings without accepting malformed values', () => {
    const expected = signWebhookPayload('whsec_test', '1720000000', '{"event":{"severity":"critical"}}');

    assert.equal(constantTimeSignatureEqual(`v1=${expected}`, expected), true);
    assert.equal(constantTimeSignatureEqual(`sha256=${expected}`, expected), true);
    assert.equal(constantTimeSignatureEqual(expected, expected), true);
    assert.equal(constantTimeSignatureEqual('v1=not-a-signature', expected), false);
    assert.equal(constantTimeSignatureEqual(`v1=${'0'.repeat(64)}`, expected), false);
  });
});
