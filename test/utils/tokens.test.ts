import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { constantTimeEqual } from '../../src/utils/tokens.js';

describe('constantTimeEqual', () => {
  it('compares bearer tokens without plain string equality', () => {
    assert.equal(constantTimeEqual('service-token', 'service-token'), true);
    assert.equal(constantTimeEqual('service-token', 'other-token'), false);
    assert.equal(constantTimeEqual('service-token', 'service-token-with-extra-bytes'), false);
  });
});
