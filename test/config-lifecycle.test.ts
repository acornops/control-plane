import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAppConfig } from '../src/config.js';
import { fieldErrors } from './helpers/config-fixtures.js';

describe('agent handoff timeout configuration', () => {
  it('defaults to the supported 45-second handoff ceiling', () => {
    assert.equal(parseAppConfig({}).AGENT_HANDOFF_TIMEOUT_MS, 45_000);
  });

  for (const timeout of [1, 30_000, 45_000]) {
    it(`accepts a ${timeout}ms handoff allowance`, () => {
      assert.equal(
        parseAppConfig({ AGENT_HANDOFF_TIMEOUT_MS: String(timeout) }).AGENT_HANDOFF_TIMEOUT_MS,
        timeout
      );
    });
  }

  for (const timeout of ['0', '-1', '1.5', '45001', '60000']) {
    it(`rejects the unsupported ${timeout}ms handoff allowance`, () => {
      assert.throws(
        () => parseAppConfig({ AGENT_HANDOFF_TIMEOUT_MS: timeout }),
        (error) => Boolean(fieldErrors(error).AGENT_HANDOFF_TIMEOUT_MS?.length)
      );
    });
  }
});
