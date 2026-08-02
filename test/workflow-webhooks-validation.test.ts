import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  constantTimeSignatureEqual
} from '../src/controllers/workflow-webhooks-controller.js';
import {
  WORKFLOW_WEBHOOK_CREATE_FIELDS,
  unexpectedBodyField
} from '../src/controllers/workflow-webhook-validation.js';
import { signWebhookPayload } from '../src/utils/crypto.js';

describe('workflow webhook validation', () => {
  it('rejects unknown mutation fields', () => {
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
