import { EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceIdParameter = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const eventTriggerIdParameter = {
  in: 'path',
  name: 'triggerId',
  required: true,
  schema: { type: 'string', format: 'uuid' }
};

const workspaceBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
        },
        additionalProperties: false
      }
    }
  }
};

const inputBindings = {
  type: 'object',
  additionalProperties: {
    type: 'string',
    enum: ['issue.id', 'issue.title', 'issue.summary', 'issue.severity', 'issue.scope', 'issue.object', 'target.id', 'target.type']
  }
};

const workflowEventTriggerBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workflowId', 'name', 'sourceType'],
        properties: {
          workflowId: { type: 'string' },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          enabled: { type: 'boolean' },
          sourceType: { type: 'string', enum: ['webhook', 'acornops_event'] },
          eventType: { type: 'string', enum: ['issue.created.v1'] },
          inputBindings,
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
  }
};

const workflowEventTriggerUpdateBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          enabled: { type: 'boolean' },
          inputBindings,
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
  }
};

export function buildWorkflowEventTriggerPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/workflow-event-triggers': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow event triggers for a workspace',
        description: 'Returns signed webhook and AcornOps event triggers. Requires read_workspace_data.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: {
          '200': {
            description: 'Workflow event-trigger list.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEventTriggerList' } } }
          }
        }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workflow event trigger',
        description: 'Binds one signed webhook or issue-created event source to one existing workflow. Webhook signing secrets are returned once. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowEventTriggerBody,
        responses: {
          '201': {
            description: 'Workflow event trigger created.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEventTriggerCreated' } } }
          }
        }
      }
    },
    '/api/v1/workflow-event-triggers/{triggerId}': {
      patch: {
        tags: ['workflows'],
        summary: 'Update a workflow event trigger',
        description: 'Updates name, enabled state, approved grants, or issue-field bindings. Source, workflow, and creator-bound run identity are immutable. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [eventTriggerIdParameter],
        requestBody: workflowEventTriggerUpdateBody,
        responses: {
          '200': {
            description: 'Workflow event trigger updated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEventTriggerResponse' } } }
          }
        }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete a workflow event trigger',
        description: 'Stops future events immediately without affecting existing workflow runs. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [eventTriggerIdParameter],
        requestBody: workspaceBody,
        responses: { '204': { description: 'Workflow event trigger deleted.' } }
      }
    },
    '/api/v1/workflow-event-triggers/{triggerId}/rotate-secret': {
      post: {
        tags: ['workflows'],
        summary: 'Rotate a webhook event-trigger signing secret',
        description: 'Invalidates the previous secret and returns the replacement once. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [eventTriggerIdParameter],
        requestBody: workspaceBody,
        responses: {
          '200': {
            description: 'Signing secret rotated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEventTriggerCreated' } } }
          }
        }
      }
    },
    '/api/v1/workflow-event-triggers/{triggerId}/events': {
      post: {
        tags: ['workflows'],
        summary: 'Submit a signed workflow webhook event',
        description: 'Accepts an inputs object after verifying X-AcornOps-Event-Id, X-AcornOps-Timestamp, and an HMAC SHA-256 X-AcornOps-Signature over `<timestamp>.<raw body>`. Events are replay-protected and limited to 256 KiB.',
        security: [],
        parameters: [
          eventTriggerIdParameter,
          { in: 'header', name: 'X-AcornOps-Event-Id', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } },
          { in: 'header', name: 'X-AcornOps-Timestamp', required: true, schema: { type: 'string' } },
          { in: 'header', name: 'X-AcornOps-Signature', required: true, schema: { type: 'string', pattern: '^v1=[a-f0-9]{64}$' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['inputs'],
                properties: {
                  inputs: { type: 'object', additionalProperties: { type: 'string' } }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          '202': {
            description: 'Event accepted for durable dispatch.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEventTriggerAccepted' } } }
          },
          '401': { description: 'Timestamp or signature invalid.' },
          '409': { description: 'Target workflow changed after the trigger was saved.' },
          '413': { description: 'Payload exceeds 256 KiB.' },
          '429': { description: 'Per-trigger request or accepted-event rate exceeded.' }
        }
      }
    }
  };
}
