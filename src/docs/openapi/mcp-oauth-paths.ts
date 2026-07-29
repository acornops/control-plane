export function buildMcpOAuthPaths(): Record<string, unknown> {
  return {
    '/api/v1/mcp/oauth/client-metadata': {
      get: {
        tags: ['auth'],
        summary: 'Read AcornOps MCP OAuth client metadata',
        description: 'CIMD document generated only from canonical deployment configuration. It contains no tenant, user, or secret data.',
        responses: {
          '200': {
            description: 'OAuth client metadata.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/McpOAuthClientMetadata' }
              }
            }
          },
          '404': { description: 'Automatic MCP OAuth is disabled.' }
        }
      }
    },
    '/api/v1/mcp/oauth/callback': {
      get: {
        tags: ['auth'],
        summary: 'Complete an MCP OAuth authorization-code flow',
        description: 'Requires the initiating AcornOps user session and browser binding. Provider parameters are exchanged server-side and the browser is redirected to a safe console path.',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'query', name: 'state', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'code', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'iss', required: false, schema: { type: 'string', format: 'uri' } },
          { in: 'query', name: 'error', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '303': { description: 'Redirects to the canonical console with a stable OAuth result.' },
          '401': { description: 'The initiating AcornOps user session is missing.' }
        }
      }
    }
  };
}
