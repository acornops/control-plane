import { externalWebhookRouteSchemas } from './schema-components-webhook-routes.js';
import { dateTime, JsonSchema, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';

export function buildWebhookSchemas(): Record<string, JsonSchema> {
  return {
    WebhookSubscription: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'url', 'eventTypes', 'enabled'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        targetId: uuid,
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        eventTypes: stringArray,
        enabled: { type: 'boolean' },
        createdBy: uuid,
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WebhookCreated: {
      allOf: [
        schemaRef('WebhookSubscription'),
        {
          type: 'object',
          required: ['secret'],
          properties: { secret: { type: 'string' } }
        }
      ],
      description: 'Webhook subscription response. Includes signing secret once.'
    },
    WebhookPage: pageOf('WebhookSubscription'),
    WebhookHistory: {
      type: 'object',
      required: [
        'id',
        'subscriptionId',
        'eventId',
        'eventType',
        'workspaceId',
        'subjectType',
        'subjectId',
        'payload',
        'status',
        'sentAt'
      ],
      properties: {
        id: uuid,
        subscriptionId: uuid,
        eventId: uuid,
        eventType: { type: 'string' },
        workspaceId: uuid,
        targetId: uuid,
        subjectType: { type: 'string' },
        subjectId: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
        status: { type: 'string', enum: ['success', 'failed'] },
        responseStatus: { type: 'integer' },
        error: { type: 'string' },
        durationMs: { type: 'integer' },
        sentAt: dateTime
      },
      additionalProperties: true
    },
    WebhookHistoryPage: pageOf('WebhookHistory'),
    ...externalWebhookRouteSchemas
  };
}
