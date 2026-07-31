import { EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceIdParameter = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const webhookIdParameter = {
  in: 'path',
  name: 'webhookId',
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

const workflowWebhookBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workflowId', 'name'],
        properties: {
          workflowId: { type: 'string' },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          enabled: { type: 'boolean' },
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
  }
};

const workflowWebhookUpdateBody = {
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
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
  }
};

export function buildWorkflowWebhookPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/workflow-webhooks': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow webhooks for a workspace',
        description: 'Returns signed incoming webhooks that launch workflows. Requires read_workspace_data.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: {
          '200': {
            description: 'Workflow webhook list.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowWebhookList' } } }
          }
        }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workflow webhook',
        description: 'Binds one signed incoming webhook to an existing workflow. The signing secret is returned once. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowWebhookBody,
        responses: {
          '201': {
            description: 'Workflow webhook created.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowWebhookCreated' } } }
          }
        }
      }
    },
    '/api/v1/workflow-webhooks/{webhookId}': {
      patch: {
        tags: ['workflows'],
        summary: 'Update a workflow webhook',
        description: 'Updates name, enabled state, or approved grants. Workflow and creator-bound run identity are immutable. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [webhookIdParameter],
        requestBody: workflowWebhookUpdateBody,
        responses: {
          '200': {
            description: 'Workflow webhook updated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowWebhookResponse' } } }
          }
        }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete a workflow webhook',
        description: 'Stops future events immediately without affecting existing workflow runs. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [webhookIdParameter],
        requestBody: workspaceBody,
        responses: { '204': { description: 'Workflow webhook deleted.' } }
      }
    },
    '/api/v1/workflow-webhooks/{webhookId}/rotate-secret': {
      post: {
        tags: ['workflows'],
        summary: 'Rotate a workflow webhook signing secret',
        description: 'Invalidates the previous secret and returns the replacement once. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [webhookIdParameter],
        requestBody: workspaceBody,
        responses: {
          '200': {
            description: 'Signing secret rotated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowWebhookCreated' } } }
          }
        }
      }
    },
    '/api/v1/workflow-webhooks/{webhookId}/events': {
      post: {
        tags: ['workflows'],
        summary: 'Submit a signed workflow webhook event',
        description: 'Accepts signed event metadata after verifying X-AcornOps-Event-Id, X-AcornOps-Timestamp, and an HMAC SHA-256 X-AcornOps-Signature over `<timestamp>.<raw body>`. Event metadata does not alter the saved workflow prompt. Events are replay-protected and limited to 256 KiB.',
        security: [],
        parameters: [
          webhookIdParameter,
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
                additionalProperties: true
              }
            }
          }
        },
        responses: {
          '202': {
            description: 'Event accepted for durable dispatch.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowWebhookAccepted' } } }
          },
          '401': { description: 'Timestamp or signature invalid.' },
          '409': { description: 'Target workflow changed after the webhook was saved.' },
          '413': { description: 'Payload exceeds 256 KiB.' },
          '429': { description: 'Per-webhook request or accepted-event rate exceeded.' }
        }
      }
    }
  };
}
