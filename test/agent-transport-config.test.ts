import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAppConfig } from '../src/config.js';

describe('agent transport and session config', () => {
  it('uses the explicit session max age', () => {
    const config = parseAppConfig({
      SESSION_MAX_AGE_SECONDS: '172800',
      SESSION_IDLE_TIMEOUT_SECONDS: '86400'
    });
    assert.equal(config.SESSION_MAX_AGE_SECONDS, 172800);
    assert.equal(config.SESSION_IDLE_TIMEOUT_SECONDS, 86400);
  });

  it('keeps authenticated agent transport large enough for complete result envelopes', () => {
    const config = parseAppConfig({});
    assert.equal(config.AGENT_WS_MAX_PAYLOAD_BYTES, 3 * 1024 * 1024);
    assert.throws(
      () => parseAppConfig({ AGENT_WS_MAX_PAYLOAD_BYTES: String(2 * 1024 * 1024) }),
      /AGENT_WS_MAX_PAYLOAD_BYTES/
    );
    assert.throws(
      () => parseAppConfig({
        AGENT_WS_MAX_PAYLOAD_BYTES: String(4 * 1024 * 1024),
        AGENT_WS_MAX_DECODED_BYTES: String(3 * 1024 * 1024)
      }),
      /AGENT_WS_MAX_DECODED_BYTES/
    );
  });
});
