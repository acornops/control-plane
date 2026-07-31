import { dateTime, type JsonSchema, schemaRef, stringArray, uuid } from './schema-types.js';

export function buildWorkflowWebhookSchemas(): Record<string, JsonSchema> {
  return {
    WorkflowWebhook: {
      type: 'object',
      required: [
        'id',
        'workspaceId',
        'workflowId',
        'name',
        'status',
        'approvedContextGrants',
        'principal',
        'endpointUrl'
      ],
      properties: {
        id: uuid,
        workspaceId: uuid,
        workflowId: { type: 'string', example: 'workflow-cluster-daily-triage' },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        status: { type: 'string', enum: ['enabled', 'paused'] },
        approvedContextGrants: stringArray,
        principal: {
          type: 'object',
          required: ['type', 'id'],
          properties: {
            type: { type: 'string', enum: ['user'] },
            id: { type: 'string' }
          },
          additionalProperties: false
        },
        endpointUrl: { type: 'string', format: 'uri' },
        lastReceivedAt: { oneOf: [dateTime, { type: 'null' }] },
        lastStatus: { oneOf: [{ type: 'string', enum: ['dispatched', 'failed', 'auto_paused', 'rejected'] }, { type: 'null' }] },
        lastExecutionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        lastRunId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        latestExecution: { oneOf: [schemaRef('WorkflowExecutionSummary'), { type: 'null' }] },
        lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] }
      },
      additionalProperties: false
    },
    WorkflowWebhookList: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkflowWebhook') }
      },
      additionalProperties: false
    },
    WorkflowWebhookResponse: {
      type: 'object',
      required: ['webhook'],
      properties: { webhook: schemaRef('WorkflowWebhook') },
      additionalProperties: false
    },
    WorkflowWebhookCreated: {
      type: 'object',
      required: ['webhook', 'signingSecret'],
      properties: {
        webhook: schemaRef('WorkflowWebhook'),
        signingSecret: {
          type: 'object',
          required: ['url', 'secret', 'secretDisclosure'],
          properties: {
            url: { type: 'string', format: 'uri' },
            secret: { type: 'string', pattern: '^whsec_' },
            secretDisclosure: { type: 'string', enum: ['one_time'] }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    WorkflowWebhookAccepted: {
      type: 'object',
      required: ['eventId', 'status'],
      properties: {
        eventId: { type: 'string', minLength: 1, maxLength: 200 },
        status: { type: 'string', enum: ['accepted'] }
      },
      additionalProperties: false
    }
  };
}
