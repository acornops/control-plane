import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeToolInputSchema } from '../../src/services/tool-metadata.js';

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (value && typeof value === 'object') return Object.values(value).some(containsNull);
  return false;
}

describe('tool metadata sanitization', () => {
  it('keeps deeply nested provider schemas valid without injecting null values', () => {
    const sanitized = sanitizeToolInputSchema({
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            oneOf: [{
              type: 'object',
              properties: {
                scope: { type: 'string', enum: ['resource', 'pod_template'] },
                expected_value: { anyOf: [{ type: 'string' }, { type: 'null' }] }
              },
              additionalProperties: false
            }]
          }
        }
      }
    }) as any;

    const operation = sanitized.properties.changes.items.oneOf[0];
    assert.deepEqual(operation.properties.scope.enum, ['resource', 'pod_template']);
    assert.deepEqual(operation.properties.expected_value.anyOf, [{ type: 'string' }, { type: 'null' }]);
    assert.equal(operation.additionalProperties, false);
    assert.equal(containsNull(sanitized), false);
  });

  it('preserves intentional null literals and omits unsupported metadata values', () => {
    const sanitized = sanitizeToolInputSchema({
      type: 'object',
      properties: {
        nullable_literal: { const: null },
        unsupported: () => undefined
      }
    }) as any;

    assert.equal(sanitized.properties.nullable_literal.const, null);
    assert.equal('unsupported' in sanitized.properties, false);
  });
});
