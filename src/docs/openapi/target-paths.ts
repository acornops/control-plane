import { EXAMPLE_MCP_SERVER_ID, EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';
import { TARGET_TYPES } from '../../types/domain.js';

export function buildTargetPaths(exampleServerUrl: string): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/targets': {
      get: {
        tags: ['workspaces'],
        summary: 'List targets in a workspace',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'targetType', required: false, schema: { type: 'string', enum: [...TARGET_TYPES] } }
        ],
        responses: {
          '200': { description: 'Target summary page payload: { items, nextCursor? }.' },
          '400': { description: 'Invalid cursor or targetType filter.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}': {
      get: {
        tags: ['workspaces'],
        summary: 'Get target summary',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: { '200': { description: 'Target summary.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/catalog': {
      get: {
        tags: ['workspaces'],
        summary: 'List target tools grouped by server with configured/effective state',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Target tool catalog grouped by paged server summaries.' },
          '400': { description: 'Unsupported target type for tool catalog in this release.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers': {
      get: {
        tags: ['workspaces'],
        summary: 'List remote MCP servers configured for a target',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: {
          '200': { description: 'MCP server list.' }
        }
      },
      post: {
        tags: ['workspaces'],
        summary: 'Create a target MCP server and discover its tools',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'url'],
                properties: {
                  name: { type: 'string', example: 'github' },
                  url: { type: 'string', format: 'uri', example: exampleServerUrl },
                  enabled: { type: 'boolean', default: true },
                  publicHeaders: { type: 'object', additionalProperties: { type: 'string' } },
                  auth: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'], example: 'bearer_token' },
                      secretName: { type: 'string', example: 'mcp_server::github' },
                      secretValue: { type: 'string', example: 'ghp_example_token' },
                      headerName: { type: 'string', example: 'Authorization' },
                      headerPrefix: { type: 'string', example: 'Bearer ' }
                    }
                  }
                },
                example: {
                  name: 'github',
                  url: exampleServerUrl,
                  enabled: true,
                  publicHeaders: { 'x-client-version': '2026-05' },
                  auth: {
                    type: 'bearer_token',
                    secretName: 'mcp_server::github',
                    headerName: 'Authorization',
                    headerPrefix: 'Bearer '
                  }
                }
              }
            }
          }
        },
        responses: { '201': { description: 'MCP server created.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Update target MCP server settings and tool mappings',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_MCP_SERVER_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'github' },
                  enabled: { type: 'boolean' },
                  publicHeaders: { type: 'object', additionalProperties: { type: 'string' } },
                  auth: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'], example: 'bearer_token' },
                      secretName: { type: 'string', example: 'mcp_server::github' },
                      secretValue: { type: 'string', example: 'ghp_rotated_example_token' },
                      headerName: { type: 'string', example: 'Authorization' },
                      headerPrefix: { type: 'string', example: 'Bearer ' }
                    }
                  },
                  tools: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name'],
                      properties: {
                        name: { type: 'string', example: 'github.search_repositories' },
                        timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
                        inputSchema: { type: 'object', additionalProperties: true },
                        enabled: { type: 'boolean' }
                      }
                    }
                  },
                  removeTools: {
                    type: 'array',
                    items: { type: 'string', example: 'github.search_repositories' }
                  }
                },
                example: {
                  enabled: true,
                  publicHeaders: { 'x-client-version': '2026-05' },
                  auth: {
                    type: 'bearer_token',
                    secretName: 'mcp_server::github',
                    headerName: 'Authorization',
                    headerPrefix: 'Bearer '
                  },
                  tools: [{ name: 'github.search_repositories', timeoutMs: 10000, enabled: true }],
                  removeTools: ['github.old_tool']
                }
              }
            }
          }
        },
        responses: { '200': { description: 'MCP server updated.' } }
      },
      delete: {
        tags: ['workspaces'],
        summary: 'Delete a target MCP server and its tool mappings',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_MCP_SERVER_ID } }
        ],
        responses: { '204': { description: 'MCP server deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/test-connection': {
      post: {
        tags: ['workspaces'],
        summary: 'Test target MCP server connectivity and tool discovery',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_MCP_SERVER_ID } }
        ],
        responses: { '200': { description: 'Connection test completed.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/tools': {
      get: {
        tags: ['workspaces'],
        summary: 'List tools for one target MCP server',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_MCP_SERVER_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'capability', required: false, schema: { type: 'string', enum: ['read', 'write'] } },
          { in: 'query', name: 'enabled', required: false, schema: { type: 'boolean' } }
        ],
        responses: { '200': { description: 'MCP server tool page payload: { items, nextCursor? }.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/tools/{toolName}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Enable or disable a discovered target tool',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'toolName', required: true, schema: { type: 'string', example: 'github.search_repositories' } }
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
                  capability: {
                    type: 'string',
                    enum: ['read', 'write'],
                    description: 'Required when enabling a discovered external MCP tool.'
                  }
                },
                example: { enabled: true, capability: 'read' }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Tool setting updated.' },
          '404': { description: 'Tool not found.' }
        }
      }
    }
  };
}
