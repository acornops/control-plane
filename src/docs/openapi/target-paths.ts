import { EXAMPLE_MCP_SERVER_ID, EXAMPLE_TARGET_ID, EXAMPLE_TARGET_SKILL_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';
import { TARGET_TYPES } from '../../types/domain.js';
import { buildTargetToolPaths } from './target-tool-paths.js';

export function buildTargetPaths(exampleServerUrl: string): Record<string, unknown> {
  const targetSkillSourceSchema = {
    type: 'object',
    required: ['type', 'syncStatus'],
    properties: {
      type: { type: 'string', enum: ['manual', 'git_import'] },
      repoUrl: { type: 'string', format: 'uri' },
      ref: { type: 'string' },
      subpath: { type: 'string' },
      commitSha: { type: 'string' },
      syncStatus: { type: 'string', enum: ['not_applicable', 'current', 'modified'] }
    }
  };
  const targetSkillSummarySchema = {
    type: 'object',
    required: [
      'id',
      'workspaceId',
      'targetId',
      'targetType',
      'name',
      'description',
      'enabled',
      'validationStatus',
      'validationErrors',
      'bundleStats',
      'source',
      'createdAt',
      'updatedAt'
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      workspaceId: { type: 'string', format: 'uuid' },
      targetId: { type: 'string', format: 'uuid' },
      targetType: { type: 'string', enum: [...TARGET_TYPES] },
      clusterId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      validationStatus: { type: 'string', enum: ['valid', 'invalid'] },
      validationErrors: { type: 'array', items: { type: 'string' } },
      bundleStats: {
        type: 'object',
        required: ['fileCount', 'totalBytes'],
        properties: {
          fileCount: { type: 'integer', minimum: 1, maximum: 16 },
          totalBytes: { type: 'integer', minimum: 0, maximum: 131072 }
        }
      },
      source: targetSkillSourceSchema,
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  };
  const targetSkillFileSchema = {
    type: 'object',
    required: ['path', 'content', 'sizeBytes'],
    properties: {
      path: { type: 'string', example: 'SKILL.md' },
      content: { type: 'string' },
      sizeBytes: { type: 'integer', minimum: 0, maximum: 32768 }
    }
  };
  const targetSkillDetailSchema = {
    allOf: [
      targetSkillSummarySchema,
      {
        type: 'object',
        required: ['files'],
        properties: {
          files: { type: 'array', items: targetSkillFileSchema }
        }
      }
    ]
  };
  const targetSkillCatalogSchema = {
    type: 'object',
    required: ['workspaceId', 'targetId', 'targetType', 'permissions', 'items'],
    properties: {
      workspaceId: { type: 'string', format: 'uuid' },
      targetId: { type: 'string', format: 'uuid' },
      targetType: { type: 'string', enum: [...TARGET_TYPES] },
      clusterId: { type: 'string', format: 'uuid' },
      permissions: {
        type: 'object',
        required: ['canEdit', 'editableRoles'],
        properties: {
          canEdit: { type: 'boolean' },
          editableRoles: { type: 'array', items: { type: 'string' } }
        }
      },
      items: { type: 'array', items: targetSkillSummarySchema },
      nextCursor: { type: 'string' }
    }
  };
  const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
    description,
    content: {
      'application/json': {
        schema
      }
    }
  });

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
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/issues': {
      get: {
        tags: ['workspaces'],
        summary: 'List durable operational issues for a target',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['active', 'recovering', 'resolved', 'all'] } },
          { in: 'query', name: 'severity', required: false, schema: { type: 'string', enum: ['critical', 'warning', 'info'] } },
          { in: 'query', name: 'namespace', required: false, schema: { type: 'string', example: 'default' } }
        ],
        responses: { '200': { description: 'Issue page payload: { items, nextCursor? }.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/catalog': {
      get: {
        tags: ['workspaces'],
        summary: 'List target MCP tools grouped by server with configured/effective state',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Target MCP catalog grouped by paged server summaries.' },
          '400': { description: 'Unsupported target type for MCP catalog in this release.' }
        }
      }
    },
    ...buildTargetToolPaths(),
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
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/mcp/servers/{serverId}/tools/{toolName}': {
      patch: {
        tags: ['workspaces'],
        summary: 'Enable or disable an MCP-discovered target tool',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'serverId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_MCP_SERVER_ID } },
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
          '200': { description: 'MCP tool setting updated.' },
          '404': { description: 'MCP server or tool not found.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/skills': {
      get: {
        tags: ['workspaces'],
        summary: 'List target-scoped troubleshooting skills',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } }
        ],
        responses: { '200': jsonResponse('Target skill catalog page payload with permissions, items, and nextCursor.', targetSkillCatalogSchema) }
      },
      post: {
        tags: ['workspaces'],
        summary: 'Create a manual target troubleshooting skill from Markdown files',
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
                required: ['files'],
                properties: {
                  files: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['path', 'content'],
                      properties: {
                        path: { type: 'string', example: 'SKILL.md' },
                        content: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { '201': jsonResponse('Target skill created. Valid manual skills are enabled automatically; invalid skills are stored disabled.', targetSkillDetailSchema) }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/skills/import': {
      post: {
        tags: ['workspaces'],
        summary: 'Import a target troubleshooting skill from an unauthenticated GitHub repository snapshot',
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
                required: ['repoUrl'],
                properties: {
                  repoUrl: { type: 'string', format: 'uri', example: 'https://github.com/openai/skills/tree/main/skills/.curated/cli-creator' },
                  ref: { type: 'string', example: 'main' },
                  subpath: { type: 'string', example: 'skills/troubleshooting-cnpg' }
                }
              }
            }
          }
        },
        responses: { '201': jsonResponse('Target skill imported. Valid imported skills are enabled automatically; invalid imports are stored disabled with validation errors.', targetSkillDetailSchema) }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/skills/{skillId}': {
      get: {
        tags: ['workspaces'],
        summary: 'Get full target troubleshooting skill detail',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'skillId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_SKILL_ID } }
        ],
        responses: { '200': jsonResponse('Target skill detail, including Markdown files.', targetSkillDetailSchema) }
      },
      patch: {
        tags: ['workspaces'],
        summary: 'Update target troubleshooting skill enablement and/or Markdown files',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'skillId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_SKILL_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  files: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['path', 'content'],
                      properties: {
                        path: { type: 'string', example: 'SKILL.md' },
                        content: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { '200': jsonResponse('Target skill updated.', targetSkillDetailSchema) }
      },
      delete: {
        tags: ['workspaces'],
        summary: 'Delete a target troubleshooting skill',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'skillId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_SKILL_ID } }
        ],
        responses: { '204': { description: 'Target skill deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/skills/{skillId}/reimport': {
      post: {
        tags: ['workspaces'],
        summary: 'Reimport a GitHub-backed target troubleshooting skill snapshot',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'path', name: 'skillId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_SKILL_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  force: { type: 'boolean', default: false }
                }
              }
            }
          }
        },
        responses: { '200': jsonResponse('Target skill reimported.', targetSkillDetailSchema) }
      }
    }
  };
}
