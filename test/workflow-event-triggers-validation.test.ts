import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constantTimeSignatureEqual,
  validateEventTriggerContextGrants,
  validateIssueBindings,
  validateWebhookInputs,
  webhookInputsValid
} from '../src/controllers/workflow-event-triggers-controller.js';
import {
  EVENT_TRIGGER_CREATE_FIELDS,
  parseContextGrantList,
  unexpectedBodyField
} from '../src/controllers/workflow-event-trigger-validation.js';
import { signWebhookPayload } from '../src/utils/crypto.js';

describe('workflow event-trigger validation', () => {
  it('requires complete, declared issue bindings and target IDs for target parameters', () => {
    const parameters = [
      { key: 'target', type: 'target' as const, required: true as const },
      { key: 'summary', type: 'text' as const, required: true as const }
    ];

    assert.equal(validateIssueBindings(parameters, {
      target: 'target.id',
      summary: 'issue.summary'
    }), null);
    assert.match(validateIssueBindings(parameters, {
      target: 'issue.id',
      summary: 'issue.summary'
    }) || '', /must use the target ID/);
    assert.match(validateIssueBindings(parameters, {
      target: 'target.id'
    }) || '', /Select an issue field for summary/);
    assert.match(validateIssueBindings(parameters, {
      target: 'target.id',
      summary: 'issue.summary',
      undeclared: 'issue.id'
    }) || '', /not declared/);
  });

  it('rejects issue event triggers for workflows with chat parameters', () => {
    assert.match(validateIssueBindings([
      { key: 'incident_context', type: 'chat', required: true }
    ], { incident_context: 'issue.summary' }) || '', /do not support workflows with chat parameters/);
  });

  it('requires exactly the workflow context grants', () => {
    assert.equal(validateEventTriggerContextGrants(
      ['workspace.summary'],
      ['workspace.summary']
    ), null);
    assert.match(validateEventTriggerContextGrants(
      ['workspace.summary'],
      []
    ) || '', /Approve the workspace.summary/);
    assert.match(validateEventTriggerContextGrants(
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
      unexpectedBodyField({ workflowId: 'workflow-1', principal: { id: 'user-2' } }, EVENT_TRIGGER_CREATE_FIELDS),
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
