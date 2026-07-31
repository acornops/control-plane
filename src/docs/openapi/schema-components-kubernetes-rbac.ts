import { JsonSchema, schemaRef } from './schema-types.js';

/** Return user-facing Kubernetes RBAC onboarding catalog schemas. */
export function buildKubernetesRbacSchemas(): Record<string, JsonSchema> {
  return {
    KubernetesRbacAdditionResource: {
      type: 'object',
      required: ['apiGroup', 'apiVersion', 'resource', 'kind', 'scope', 'verbs'],
      properties: {
        apiGroup: { type: 'string' },
        apiVersion: { type: 'string' },
        resource: { type: 'string' },
        kind: { type: 'string' },
        scope: { type: 'string', enum: ['namespaced', 'cluster'] },
        verbs: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: { type: 'string', enum: ['get', 'list', 'watch', 'create', 'patch', 'delete'] }
        }
      },
      additionalProperties: false
    },
    KubernetesRbacAddition: {
      type: 'object',
      required: ['key', 'name', 'resources'],
      properties: {
        key: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        resources: { type: 'array', minItems: 1, maxItems: 50, items: schemaRef('KubernetesRbacAdditionResource') }
      },
      additionalProperties: false
    },
    KubernetesRbacAdditionsValue: {
      type: 'object',
      required: ['additions'],
      properties: {
        additions: { type: 'array', maxItems: 25, items: schemaRef('KubernetesRbacAddition') }
      },
      additionalProperties: false
    },
    KubernetesRbacAdditionsOverride: {
      type: 'object',
      required: ['upserts', 'disabledKeys'],
      properties: {
        upserts: { type: 'array', maxItems: 25, items: schemaRef('KubernetesRbacAddition') },
        disabledKeys: { type: 'array', maxItems: 25, uniqueItems: true, items: { type: 'string' } }
      },
      description: 'Runtime overlay merged with the deployment profile baseline for future cluster onboarding.',
      additionalProperties: false
    },
    KubernetesRbacAdditionSummary: {
      type: 'object',
      required: ['key', 'name'],
      properties: {
        key: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' }
      },
      additionalProperties: false
    },
    KubernetesRbacAdditions: {
      type: 'object',
      required: ['version', 'items'],
      properties: {
        version: { type: 'integer', minimum: 0 },
        items: { type: 'array', items: schemaRef('KubernetesRbacAdditionSummary') }
      },
      additionalProperties: false
    }
  };
}
