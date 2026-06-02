import { EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

export function buildWebhookPaths(): Record<string, unknown> {
  return {
'/api/v1/workspaces/{workspaceId}/webhooks': {
        get: {
          tags: ['webhooks'],
          summary: 'List webhook subscriptions for a workspace',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } }
          ],
          responses: { '200': { description: 'Webhook subscription list.' } }
        },
        post: {
          tags: ['webhooks'],
          summary: 'Create a webhook subscription and return its signing secret once',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'url', 'eventTypes'],
                  properties: {
                    name: { type: 'string', example: 'PagerDuty webhook' },
                    url: { type: 'string', format: 'uri', example: 'https://example.com/acornops/webhook' },
                    eventTypes: {
                      type: 'array',
                      items: { type: 'string', example: 'run.failed.v1' }
                    },
                    targetId: { type: ['string', 'null'], format: 'uuid', example: EXAMPLE_TARGET_ID },
                    enabled: { type: 'boolean', default: true }
                  },
                  example: {
                    name: 'PagerDuty webhook',
                    url: 'https://example.com/acornops/webhook',
                    eventTypes: ['run.completed.v1', 'run.failed.v1'],
                    targetId: null,
                    enabled: true
                  }
                }
              }
            }
          },
          responses: {
            '201': { description: 'Webhook subscription created. Response includes secret once.' },
            '403': { description: 'Requires permissions.manage_webhooks.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/webhooks/{webhookId}': {
        get: {
          tags: ['webhooks'],
          summary: 'Get webhook subscription details',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'webhookId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          responses: { '200': { description: 'Webhook subscription details.' } }
        },
        patch: {
          tags: ['webhooks'],
          summary: 'Update webhook subscription settings',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'webhookId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    url: { type: 'string', format: 'uri' },
                    eventTypes: { type: 'array', items: { type: 'string' } },
                    targetId: { type: ['string', 'null'], format: 'uuid' },
                    enabled: { type: 'boolean' }
                  },
                  example: {
                    enabled: false
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Webhook subscription updated.' },
            '403': { description: 'Requires permissions.manage_webhooks.' },
            '404': { description: 'Webhook not found.' }
          }
        },
        delete: {
          tags: ['webhooks'],
          summary: 'Delete a webhook subscription',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'webhookId', required: true, schema: { type: 'string', format: 'uuid' } }
          ],
          responses: {
            '204': { description: 'Webhook deleted.' },
            '403': { description: 'Requires permissions.manage_webhooks.' },
            '404': { description: 'Webhook not found.' }
          }
        }
      },
      '/api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/history': {
        get: {
          tags: ['webhooks'],
          summary: 'List webhook delivery history',
          security: [{ userSession: [] }],
          parameters: [
            { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
            { in: 'path', name: 'webhookId', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, example: 50 } }
          ],
          responses: {
            '200': { description: 'Webhook delivery history.' },
            '403': { description: 'Requires permissions.manage_webhooks.' }
          }
        }
      },
  };
}
