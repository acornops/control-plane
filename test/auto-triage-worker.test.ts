import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { autoTriageBlockedBackoffDelaySeconds } from '../src/services/auto-triage-retry-timing.js';

describe('target auto-triage worker retry policy', () => {
  it('backs readiness and cancellation retries off exponentially with a fifteen-minute cap', () => {
    assert.equal(autoTriageBlockedBackoffDelaySeconds(1), 30);
    assert.equal(autoTriageBlockedBackoffDelaySeconds(2), 60);
    assert.equal(autoTriageBlockedBackoffDelaySeconds(3), 120);
    assert.equal(autoTriageBlockedBackoffDelaySeconds(5), 480);
    assert.equal(autoTriageBlockedBackoffDelaySeconds(6), 900);
    assert.equal(autoTriageBlockedBackoffDelaySeconds(100), 900);
  });
});
