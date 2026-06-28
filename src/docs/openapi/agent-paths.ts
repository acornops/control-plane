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

export function buildAgentPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/agents': {
      get: {
        tags: ['agents'],
        summary: 'List active workspace agents',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
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
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter],
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
      }
    },
    '/api/v1/agents/{agentId}/versions': {
      post: {
        tags: ['agents'],
        summary: 'Snapshot the current agent version',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        responses: { '201': { description: 'Agent version snapshot created.' } }
      }
    },
    '/api/v1/agents/{agentId}/test': {
      post: {
        tags: ['agents'],
        summary: 'Compile and enqueue an agent test run',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        responses: { '202': { description: 'Agent test activity queued.' } }
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
        responses: { '201': { description: 'Agent trigger created.' } }
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
        responses: { '204': { description: 'Agent trigger deleted.' } }
      }
    }
  };
}
