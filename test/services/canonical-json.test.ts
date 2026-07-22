import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import fixtureJson from '../../docs/contracts/canonical-json-vectors.json' with { type: 'json' };
import { canonicalJson, canonicalJsonSha256 } from '../../src/services/canonical-json.js';

type Fixture = {
  cases: Array<{ name: string; inputJson: string; canonical: string; sha256: string }>;
  finiteDoubleSample: { seed: string; count: number; newlineDelimitedCanonicalSha256: string };
};

const fixture = fixtureJson as Fixture;

function sampledFiniteDoubles(seed: string, count: number): number[] {
  const mask = (1n << 64n) - 1n;
  let state = BigInt(`0x${seed}`);
  const values: number[] = [];
  while (values.length < count) {
    state ^= state >> 12n;
    state ^= (state << 25n) & mask;
    state ^= state >> 27n;
    const bits = (state * 0x2545f4914f6cdd1dn) & mask;
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, bits, false);
    const value = new DataView(buffer).getFloat64(0, false);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

describe('canonical JSON conformance', () => {
  for (const vector of fixture.cases) {
    it(vector.name, () => {
      const value = JSON.parse(vector.inputJson) as unknown;
      assert.equal(canonicalJson(value), vector.canonical);
      assert.equal(canonicalJsonSha256(value), vector.sha256);
    });
  }

  it('matches the deterministic randomized finite-double sample', () => {
    const sample = sampledFiniteDoubles(fixture.finiteDoubleSample.seed, fixture.finiteDoubleSample.count);
    const payload = `${sample.map((value) => canonicalJson(value)).join('\n')}\n`;
    assert.equal(
      createHash('sha256').update(payload).digest('hex'),
      fixture.finiteDoubleSample.newlineDelimitedCanonicalSha256
    );
  });
});
