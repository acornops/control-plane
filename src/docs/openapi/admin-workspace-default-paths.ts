export function buildAdminWorkspaceDefaultPaths(
  adminSecurity: Array<Record<string, string[]>>
): Record<string, unknown> {
  const destination = { type: 'string', enum: ['agents', 'kubernetes', 'virtual_machines'] };
  const availability = {
    type: 'array',
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: destination
  };
  const reason = { type: 'string', minLength: 3, maxLength: 500 };
  return {
    '/admin/v1/system/workspace-defaults/resolve-skill': {
      post: {
        tags: ['admin'],
        summary: 'Resolve an allowed Git URL to a pinned workspace-default skill snapshot',
        description: 'Uses the deployment Git-host allowlist and anonymous provider API access.',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['repoUrl'],
                properties: {
                  repoUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 },
                  ref: { type: 'string', minLength: 1, maxLength: 255 },
                  subpath: { type: 'string', minLength: 1, maxLength: 512 }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: { '200': { description: 'Pinned Markdown snapshot.' } }
      }
    },
    '/admin/v1/system/workspace-defaults': {
      get: {
        tags: ['admin'],
        summary: 'List platform MCP server and skill defaults',
        security: adminSecurity,
        parameters: [
          { in: 'query', name: 'kind', schema: { type: 'string', enum: ['mcp_server', 'skill'] } },
          { in: 'query', name: 'availableIn', schema: destination },
          { in: 'query', name: 'q', schema: { type: 'string', maxLength: 200 } }
        ],
        responses: { '200': { description: 'Secret-free definitions used to initialize newly created workspaces.' } }
      },
      post: {
        tags: ['admin'],
        summary: 'Add a platform MCP server, manual skill, or pinned Git skill default',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['kind', 'name', 'availableIn', 'source', 'reason'],
                    properties: {
                      kind: { type: 'string', enum: ['mcp_server'] },
                      name: { type: 'string', minLength: 1, maxLength: 200 },
                      availableIn: availability,
                      source: {
                        type: 'object',
                        required: ['type', 'endpoint'],
                        properties: {
                          type: { type: 'string', enum: ['https'] },
                          endpoint: { type: 'string', format: 'uri', maxLength: 2048 }
                        },
                        additionalProperties: false
                      },
                      reason
                    },
                    additionalProperties: false
                  },
                  {
                    type: 'object',
                    required: ['kind', 'availableIn', 'source', 'files', 'reason'],
                    properties: {
                      kind: { type: 'string', enum: ['skill'] },
                      availableIn: availability,
                      source: {
                        oneOf: [
                          {
                            type: 'object',
                            required: ['type'],
                            properties: {
                              type: { type: 'string', enum: ['manual'] }
                            },
                            additionalProperties: false
                          },
                          {
                            type: 'object',
                            required: ['type', 'provider', 'repoUrl', 'ref', 'commitSha'],
                            properties: {
                              type: { type: 'string', enum: ['git'] },
                              provider: { type: 'string', enum: ['github', 'gitlab'] },
                              repoUrl: { type: 'string', format: 'uri', maxLength: 2048 },
                              ref: { type: 'string', minLength: 1, maxLength: 255 },
                              subpath: { type: 'string', maxLength: 512 },
                              commitSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' }
                            },
                            additionalProperties: false
                          }
                        ]
                      },
                      files: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 16,
                        writeOnly: true,
                        items: {
                          type: 'object',
                          required: ['path', 'content'],
                          properties: {
                            path: { type: 'string', maxLength: 512 },
                            content: { type: 'string', maxLength: 32768, writeOnly: true }
                          },
                          additionalProperties: false
                        }
                      },
                      reason
                    },
                    additionalProperties: false
                  }
                ]
              }
            }
          }
        },
        responses: { '201': { description: 'Created a future-workspace initialization default without skill contents or credentials.' } }
      }
    },
    '/admin/v1/system/workspace-defaults/{id}': {
      parameters: [{
        in: 'path',
        name: 'id',
        required: true,
        schema: { type: 'string', format: 'uuid' }
      }],
      patch: {
        tags: ['admin'],
        summary: 'Change whether or where a default will appear in newly created workspaces',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                anyOf: [
                  { required: ['availableIn'] },
                  { required: ['enabled'] }
                ],
                properties: {
                  availableIn: availability,
                  enabled: {
                    type: 'boolean',
                    description: 'Whether this definition is copied into workspaces created after the change.'
                  },
                  reason
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: { '200': { description: 'Updated the future-workspace default; existing workspaces are unchanged.' }, '404': { description: 'Workspace default not found.' } }
      },
      delete: {
        tags: ['admin'],
        summary: 'Remove a default from future workspace initialization',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: { reason },
                additionalProperties: false
              }
            }
          }
        },
        responses: { '204': { description: 'Default removed; existing workspaces are unchanged.' }, '404': { description: 'Workspace default not found.' } }
      }
    }
  };
}
