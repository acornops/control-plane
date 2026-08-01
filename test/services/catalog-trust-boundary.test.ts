import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import publicHeaderVectorsJson from '../../docs/contracts/mcp-public-header-vectors.json' with { type: 'json' };
import {
  InvalidMcpPublicHeadersError,
  validateMcpPublicHeaders
} from '../../src/services/mcp-public-header-policy.js';

const publicHeaderVectors = publicHeaderVectorsJson as {
  cases: Array<{ name: string; headers: Array<[string, string]>; valid: boolean }>;
};

describe('MCP catalog trust-boundary validation', () => {
  it('matches the cross-runtime public-header vectors', () => {
    for (const vector of publicHeaderVectors.cases) {
      const headers = Object.fromEntries(vector.headers);
      if (vector.valid) {
        assert.deepEqual(validateMcpPublicHeaders(headers), headers, vector.name);
      } else {
        assert.throws(() => validateMcpPublicHeaders(headers), InvalidMcpPublicHeadersError, vector.name);
      }
    }
  });
});
