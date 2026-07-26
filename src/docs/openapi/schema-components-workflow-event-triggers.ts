import { dateTime, type JsonSchema, schemaRef, stringArray, uuid } from './schema-types.js';

export function buildWorkflowEventTriggerSchemas(): Record<string, JsonSchema> {
  return {
    WorkflowEventTrigger: {
      type: 'object',
      required: ['id', 'workspaceId', 'workflowId', 'name', 'status', 'sourceType', 'inputBindings', 'approvedContextGrants', 'principal'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        workflowId: { type: 'string', example: 'workflow-cluster-daily-triage' },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        status: { type: 'string', enum: ['enabled', 'paused'] },
        sourceType: { type: 'string', enum: ['webhook', 'acornops_event'] },
        eventType: { oneOf: [{ type: 'string', enum: ['issue.created.v1'] }, { type: 'null' }] },
        inputBindings: {
          type: 'object',
          additionalProperties: {
            type: 'string',
            enum: ['issue.id', 'issue.title', 'issue.summary', 'issue.severity', 'issue.scope', 'issue.object', 'target.id', 'target.type']
          }
        },
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
        lastTriggeredAt: { oneOf: [dateTime, { type: 'null' }] },
        lastStatus: { oneOf: [{ type: 'string', enum: ['dispatched', 'failed', 'auto_paused', 'rejected'] }, { type: 'null' }] },
        lastExecutionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        lastRunId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        latestExecution: { oneOf: [schemaRef('WorkflowExecutionSummary'), { type: 'null' }] },
        lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] }
      },
      additionalProperties: false
    },
    WorkflowEventTriggerList: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkflowEventTrigger') }
      },
      additionalProperties: false
    },
    WorkflowEventTriggerResponse: {
      type: 'object',
      required: ['trigger'],
      properties: { trigger: schemaRef('WorkflowEventTrigger') },
      additionalProperties: false
    },
    WorkflowEventTriggerCreated: {
      type: 'object',
      required: ['trigger'],
      properties: {
        trigger: schemaRef('WorkflowEventTrigger'),
        webhook: {
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
    WorkflowEventTriggerAccepted: {
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
