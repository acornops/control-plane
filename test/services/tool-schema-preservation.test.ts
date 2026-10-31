import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { sanitizeToolInputSchema } from '../../src/services/tool-metadata.js';

const cases = JSON.parse(readFileSync(new URL('../fixtures/tool-schema-preservation.json', import.meta.url), 'utf8'));
for (const entry of cases) {
  it(`preserves schema semantics: ${entry.name}`, () => {
    const original = structuredClone(entry.schema);
    const prepared = sanitizeToolInputSchema(entry.schema);
    assert.deepEqual(prepared, entry.expected);
    assert.equal(JSON.stringify(prepared), JSON.stringify(entry.expected));
    assert.deepEqual(entry.schema, original);
  });
}

it('rejects complete schemas instead of silently dropping invalid or oversized values', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = {};
  for (let i = 0; i < 18; i++) deep = { properties: { child: deep } };
  for (const schema of [[], 'bad', { enum: Array.from({ length: 101 }, (_, i) => i) },
    { const: () => 1 }, { const: NaN }, { const: Infinity }, { const: 'x'.repeat(262144) },
    { const: new Date() }, cycle, deep]) {
    assert.throws(() => sanitizeToolInputSchema(schema), /TOOL_SCHEMA_REJECTED/);
  }
});

it('keeps the existing optional missing-schema default', () => {
  assert.deepEqual(sanitizeToolInputSchema(undefined), { type: 'object', additionalProperties: true });
  assert.deepEqual(sanitizeToolInputSchema(null), { type: 'object', additionalProperties: true });
});

it('enforces exact UTF-8 byte, depth, container and traversal limits', () => {
  const schema = { const: 'é'.repeat((262144 - 12) / 2) };
  assert.equal(Buffer.byteLength(JSON.stringify(schema)), 262144);
  assert.deepEqual(sanitizeToolInputSchema(schema), schema);
  assert.throws(() => sanitizeToolInputSchema({ const: schema.const + 'é' }), /byte_limit/);
  let deep: unknown = 0;
  for (let i = 0; i < 16; i++) deep = { const: deep };
  assert.deepEqual(sanitizeToolInputSchema(deep), deep);
  assert.throws(() => sanitizeToolInputSchema({ const: deep }), /depth_limit/);
  const entries = { const: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), i])) };
  assert.deepEqual(sanitizeToolInputSchema(entries), entries);
  entries.const.excess = 0;
  assert.throws(() => sanitizeToolInputSchema(entries), /container_limit/);
  const leaf = [0, 1];
  assert.throws(() => sanitizeToolInputSchema({ const: Array(100).fill(Array(100).fill(leaf)) }), /value_limit/);
});
