export function buildInternalPaths(): Record<string, unknown> {
  return {
    '/internal/v1/agent-runs/{runId}/context': {
      get: {
        tags: ['internal'],
        summary: 'Internal: load standalone Agent run context',
        security: [{ serviceToken: [] }],
        parameters: [
          { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { '200': { description: 'Versioned Agent instructions, prompt, input context, target binding, and compiled grants.' } }
      }
    },
    '/internal/v1/workflow-sessions/{sessionId}/context': {
      get: {
        tags: ['internal'],
        summary: 'Internal: load workflow session execution context',
        security: [{ serviceToken: [] }],
        description: 'Returns the compiled workflow session context for execution-engine workflow runs.',
        parameters: [
          { in: 'path', name: 'sessionId', required: true, schema: { type: 'string', example: 'workflow-session-01' } },
          { in: 'query', name: 'run_id', required: false, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'Workflow session context.'
          }
        }
      }
    },
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
