import type { JsonSchema } from './schema-types.js';

export function buildKubernetesRbacSchemas(): Record<string, JsonSchema> {
  return {
    KubernetesRbacAdditions: {
      type: 'object',
      required: ['version', 'items'],
      properties: {
        version: { type: 'integer', minimum: 1 },
        items: {
          type: 'array',
          maxItems: 0,
          items: {
            type: 'object',
            required: ['key', 'name'],
            properties: {
              key: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    }
  };
}
