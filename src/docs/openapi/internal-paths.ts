export function buildInternalPaths(): Record<string, unknown> {
  return {
    '/internal/v1/mcp/tools/call': {
        post: {
          tags: ['internal'],
          summary: 'Internal: bridge builtin cluster-agent MCP tool execution',
          security: [{ gatewayRunToken: [] }],
          description: 'Requires the run-scoped JWT issued during execution bootstrap. Workspace, target, run, session, and allowed tools are read from JWT claims.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'get_resource_logs' },
                    arguments: { type: 'object', additionalProperties: true }
                  },
                  example: {
                    name: 'get_resource_logs',
                    arguments: {
                      namespace: 'payments',
                      name: 'payments-api-7f95b8f79-x2mhd',
                      tail_lines: 200
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'MCP-style tool result envelope returned.'
            }
          }
        }
      }
  };
}
