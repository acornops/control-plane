import { EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

export function buildTargetToolPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools': {
      get: {
        tags: ['workspaces'],
        summary: 'List built-in tools configured for a target',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: {
          '200': { description: 'Target built-in tool catalog.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolId}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Update a built-in target tool',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'toolId', required: true, schema: { type: 'string', enum: ['web_search'], example: 'web_search' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['enabled'],
                properties: {
                  enabled: { type: 'boolean', example: true },
                  config: { type: 'object', additionalProperties: true }
                },
                example: {
                  enabled: true,
                  config: {
                    domainFilters: {
                      allowedDomains: ['docs.example.com'],
                      blockedDomains: ['internal.example.com']
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Updated built-in target tool.' },
          '400': { description: 'Invalid web_search configuration.' },
          '403': { description: 'Missing manage_tools permission.' },
          '404': { description: 'Unknown toolId.' }
        }
      }
    }
  };
}
