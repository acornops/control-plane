import { EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceIdParameter = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const agentIdPathParameter = {
  in: 'path',
  name: 'agentId',
  required: true,
  schema: { type: 'string', example: 'agent-cluster-triage' }
};

const agentWorkspaceIdQueryParameter = {
  in: 'query',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const agentWorkspaceBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
        },
        additionalProperties: true
      }
    }
  }
};

export function buildAgentPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/agents': {
      get: {
        tags: ['agents'],
        summary: 'List active workspace agents',
        security: [{ userSession: [] }],
        parameters: [
          workspaceIdParameter,
          { in: 'query', name: 'includeInactive', required: false, schema: { type: 'boolean' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Agent list for the workspace.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      },
      post: {
        tags: ['agents'],
        summary: 'Create a custom workspace agent',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentMutation' }
            }
          }
        },
        responses: {
          '201': { description: 'Agent created.' },
          '403': { description: 'Requires manage_agents.' }
        }
      }
    },
    '/api/v1/agents/{agentId}': {
      get: {
        tags: ['agents'],
        summary: 'Get an agent definition',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Agent detail.' } }
      },
      patch: {
        tags: ['agents'],
        summary: 'Update an agent definition',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentMutation' }
            }
          }
        },
        responses: {
          '200': { description: 'Agent updated.' },
          '403': { description: 'Requires manage_agents.' }
        }
      },
      delete: {
        tags: ['agents'],
        summary: 'Delete an unassigned custom agent definition',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        responses: {
          '204': { description: 'Custom agent deleted.' },
          '403': { description: 'Requires manage_agents.' },
          '409': { description: 'System agents and assigned agents cannot be deleted.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/runs': {
      post: {
        tags: ['agents'], summary: 'Create a durable standalone Agent run', security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, agentIdPathParameter],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['prompt'], properties: {
            prompt: { type: 'string', minLength: 1 }, inputContext: { type: 'object' },
            targetId: { type: 'string' }, approvedContextGrants: { type: 'array', items: { type: 'string' } },
            triggerId: { type: 'string' }, clientRequestId: { type: 'string', maxLength: 128 }
          }
        } } } },
        responses: {
          '202': { description: 'Agent run and dispatch intent committed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentRunAccepted' } } } },
          '409': { description: 'Agent or selected target is not ready.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/automation/diagnostics': {
      get: {
        tags: ['agents'],
        summary: 'Inspect workspace automation readiness and durable runtime health',
        description: 'Reports automation-specific dependencies and backlogs without affecting the process-level /ready probe.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: {
          '200': { description: 'Sanitized runtime mode, queue, run, trigger, approval, template readiness, and report-source diagnostics.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/versions': {
      get: {
        tags: ['agents'],
        summary: 'List saved agent version snapshots',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Agent version snapshots.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      },
      post: {
        tags: ['agents'],
        summary: 'Snapshot the current agent version',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        responses: { '201': { description: 'Agent version snapshot created.' } }
      }
    },
    '/api/v1/agents/{agentId}/versions/{versionId}/restore': {
      post: {
        tags: ['agents'],
        summary: 'Restore a saved agent version snapshot',
        security: [{ userSession: [] }],
        parameters: [
          agentIdPathParameter,
          { in: 'path', name: 'versionId', required: true, schema: { type: 'string' } }
        ],
        requestBody: agentWorkspaceBody,
        responses: {
          '200': { description: 'Agent restored from snapshot as a new current version.' },
          '403': { description: 'Requires manage_agents.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/test': {
      post: {
        tags: ['agents'],
        summary: 'Preview Agent scope without executing (deprecated)',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        deprecated: true,
        responses: { '200': { description: 'Non-executing compiled scope preview.' } }
      }
    },
    '/api/v1/agents/{agentId}/activity': {
      get: {
        tags: ['agents'],
        summary: 'List agent activity records',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter],
        responses: { '200': { description: 'Agent activity list.' } }
      }
    },
    '/api/v1/agents/{agentId}/triggers': {
      post: {
        tags: ['agents'],
        summary: 'Create an agent trigger',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        responses: { '201': { description: 'Agent trigger created. Webhook triggers additionally return the encrypted-secret-backed HMAC secret exactly once.' } }
      }
    },
    '/api/v1/automation/webhooks/{triggerId}': {
      post: {
        tags: ['agents'],
        summary: 'Accept a signed standalone Agent webhook event',
        security: [],
        parameters: [
          { in: 'path', name: 'triggerId', required: true, schema: { type: 'string' } },
          { in: 'header', name: 'x-acornops-timestamp', required: true, schema: { type: 'string' } },
          { in: 'header', name: 'x-acornops-event-id', required: true, schema: { type: 'string', maxLength: 200 } },
          { in: 'header', name: 'x-acornops-signature', required: true, schema: { type: 'string', pattern: '^(sha256=)?[a-fA-F0-9]{64}$' } }
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', maxProperties: 1000 } } } },
        responses: {
          '202': {
            description: 'The signed event and durable trigger delivery were committed.',
            content: { 'application/json': { schema: {
              type: 'object', required: ['eventId', 'status'],
              properties: { eventId: { type: 'string' }, status: { type: 'string', enum: ['accepted'] } }
            } } }
          },
          '401': { description: 'Timestamp or HMAC signature invalid.' },
          '409': { description: 'Event ID replay rejected.' },
          '413': { description: 'Payload exceeds 256 KiB.' },
          '429': { description: 'Per-trigger rate limit exceeded.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/triggers/{triggerId}': {
      patch: {
        tags: ['agents'],
        summary: 'Update an agent trigger',
        security: [{ userSession: [] }],
        parameters: [
          agentIdPathParameter,
          { in: 'path', name: 'triggerId', required: true, schema: { type: 'string' } }
        ],
        requestBody: agentWorkspaceBody,
        responses: { '200': { description: 'Agent trigger updated.' } }
      },
      delete: {
        tags: ['agents'],
        summary: 'Delete an agent trigger',
        security: [{ userSession: [] }],
        parameters: [
          agentIdPathParameter,
          { in: 'path', name: 'triggerId', required: true, schema: { type: 'string' } }
        ],
        requestBody: agentWorkspaceBody,
        responses: { '204': { description: 'Agent trigger deleted.' } }
      }
    }
  };
}
