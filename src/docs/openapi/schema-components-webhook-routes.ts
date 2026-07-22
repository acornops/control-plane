import { JsonSchema, schemaRef, stringArray, uuid, dateTime } from './schema-types.js';

export const externalWebhookRouteSchemas: Record<string, JsonSchema> = {
  ExternalWebhookRouteSubscription: {
    type: 'object',
    required: ['workspaceId', 'workspaceName', 'webhookId', 'eventTypes', 'enabled', 'status', 'updatedAt'],
    properties: {
      workspaceId: uuid,
      workspaceName: { type: 'string' },
      webhookId: uuid,
      name: { type: 'string' },
      targetId: { ...uuid, nullable: true },
      eventTypes: stringArray,
      enabled: { type: 'boolean' },
      status: { type: 'string', enum: ['enabled', 'disabled'] },
      updatedAt: dateTime,
      signingSecret: {
        type: 'string',
        description: 'Returned only by the connect endpoint after AcornOps rotates the webhook signing secret.'
      }
    },
    additionalProperties: true
  },
  ExternalWebhookRouteConnection: {
    type: 'object',
    required: ['status', 'connectedAt', 'lastSyncedAt', 'subscriptions'],
    properties: {
      status: { type: 'string', enum: ['unconfigured', 'configured', 'connected'] },
      connectedAt: { ...dateTime, nullable: true },
      lastSyncedAt: { ...dateTime, nullable: true },
      subscriptions: { type: 'array', items: schemaRef('ExternalWebhookRouteSubscription') }
    },
    additionalProperties: true
  }
};
