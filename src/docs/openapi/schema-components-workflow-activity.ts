import { dateTime, type JsonSchema, schemaRef, uuid } from './schema-types.js';

export function buildWorkflowActivitySchemas(): Record<string, JsonSchema> {
  return {
    WorkflowExecutionOrigin: {
      type: 'object',
      required: ['schemaVersion', 'kind', 'label'],
      oneOf: [
        {
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['manual', 'external_integration', 'agent_chat', 'historical_event'] }
          }
        },
        {
          required: ['kind', 'scheduleId'],
          properties: {
            kind: { type: 'string', enum: ['schedule'] }
          }
        },
        {
          required: ['kind', 'webhookId'],
          properties: {
            kind: { type: 'string', enum: ['webhook'] }
          }
        }
      ],
      properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        kind: {
          type: 'string',
          enum: ['manual', 'external_integration', 'agent_chat', 'schedule', 'webhook', 'historical_event']
        },
        label: { type: 'string' },
        scheduleId: { type: 'string' },
        webhookId: { type: 'string' }
      },
      additionalProperties: false
    },
    WorkflowExecutionSummary: {
      type: 'object',
      required: ['id', 'workspaceId', 'workflow', 'status', 'origin', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        workspaceId: uuid,
        workflow: {
          type: 'object',
          required: ['id', 'name', 'version'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            version: { type: 'integer', minimum: 1 }
          },
          additionalProperties: false
        },
        status: {
          type: 'string',
          enum: [
            'queued',
            'dispatching',
            'running',
            'waiting_for_approval',
            'needs_review',
            'cancelling',
            'completed',
            'failed',
            'cancelled'
          ]
        },
        origin: schemaRef('WorkflowExecutionOrigin'),
        rootRun: {
          type: 'object',
          required: ['id', 'requestedAt'],
          properties: {
            id: { type: 'string' },
            targetId: { type: 'string' },
            targetName: { type: 'string' },
            targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
            requestedAt: dateTime,
            startedAt: dateTime,
            endedAt: dateTime
          },
          additionalProperties: false
        },
        createdBy: { type: 'string' },
        createdAt: dateTime,
        startedAt: dateTime,
        endedAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: false
    },
    WorkflowExecutionPage: {
      type: 'object',
      required: ['items', 'summary'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkflowExecutionSummary') },
        nextCursor: { type: 'string' },
        summary: {
          type: 'object',
          required: ['openCount', 'attentionCount'],
          properties: {
            openCount: { type: 'integer', minimum: 0 },
            attentionCount: { type: 'integer', minimum: 0 },
            latestUpdatedAt: dateTime
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    WorkflowActivitySummary: {
      type: 'object',
      required: ['totalCount', 'openCount', 'attentionCount'],
      properties: {
        totalCount: { type: 'integer', minimum: 0 },
        openCount: { type: 'integer', minimum: 0 },
        attentionCount: { type: 'integer', minimum: 0 },
        openExecution: schemaRef('WorkflowExecutionSummary'),
        latestExecution: schemaRef('WorkflowExecutionSummary')
      },
      additionalProperties: false
    }
  };
}
