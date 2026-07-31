import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constantTimeSignatureEqual,
  validateWorkflowWebhookContextGrants,
  validateWebhookInputs,
  webhookInputsValid
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

  it('accepts only string-valued webhook workflow inputs', () => {
    assert.equal(webhookInputsValid({}), true);
    assert.equal(webhookInputsValid({ target: 'cluster-1', severity: 'critical' }), true);
    assert.equal(webhookInputsValid({ target: 42 }), false);
    assert.equal(webhookInputsValid([]), false);
  });

  it('requires webhook inputs to exactly match declared workflow parameters', () => {
    const parameters = [
      { key: 'target', type: 'target' as const, required: true as const },
      { key: 'summary', type: 'text' as const, required: true as const }
    ];

    assert.equal(validateWebhookInputs(parameters, {
      target: 'cluster-1',
      summary: 'Investigate latency'
    }), null);
    assert.match(validateWebhookInputs(parameters, {
      target: 'cluster-1'
    }) || '', /summary is required/);
    assert.match(validateWebhookInputs(parameters, {
      target: 'cluster-1',
      summary: ' '
    }) || '', /summary cannot be empty/);
    assert.match(validateWebhookInputs(parameters, {
      target: 'cluster-1',
      summary: 'Investigate latency',
      extra: 'value'
    }) || '', /extra is not declared/);
  });

  it('compares supported HMAC signature encodings without accepting malformed values', () => {
    const expected = signWebhookPayload('whsec_test', '1720000000', '{"inputs":{"target":"cluster-1"}}');

    assert.equal(constantTimeSignatureEqual(`v1=${expected}`, expected), true);
    assert.equal(constantTimeSignatureEqual(`sha256=${expected}`, expected), true);
    assert.equal(constantTimeSignatureEqual(expected, expected), true);
    assert.equal(constantTimeSignatureEqual('v1=not-a-signature', expected), false);
    assert.equal(constantTimeSignatureEqual(`v1=${'0'.repeat(64)}`, expected), false);
  });
});
