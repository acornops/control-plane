import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeAgentAvatarEmoji } from '../src/controllers/agent-controller-helpers.js';

describe('Agent avatar emoji validation', () => {
  it('accepts one emoji grapheme including joined and flag sequences', () => {
    assert.equal(normalizeAgentAvatarEmoji('🛠️'), '🛠️');
    assert.equal(normalizeAgentAvatarEmoji('👩🏽‍💻'), '👩🏽‍💻');
    assert.equal(normalizeAgentAvatarEmoji('🇸🇬'), '🇸🇬');
  });

  it('rejects text, empty values, and multiple emojis', () => {
    assert.equal(normalizeAgentAvatarEmoji('Agent'), undefined);
    assert.equal(normalizeAgentAvatarEmoji(''), undefined);
    assert.equal(normalizeAgentAvatarEmoji('🔎📝'), undefined);
  });
});
