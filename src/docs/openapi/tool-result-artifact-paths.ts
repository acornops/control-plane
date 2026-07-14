/** OpenAPI paths for short-lived complete redacted tool results. */
export function buildToolResultArtifactPaths(): Record<string, unknown> {
  return {
    '/internal/v1/runs/{runId}/tool-result-artifacts': {
      post: {
        tags: ['internal'], summary: 'Internal: persist a trusted full tool result artifact',
        security: [{ serviceToken: [] }],
        parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['callId', 'toolName', 'result'],
          properties: {
            callId: { type: 'string', minLength: 1, maxLength: 256 },
            toolName: { type: 'string', minLength: 1, maxLength: 128 },
            result: {}, contentType: { type: 'string', enum: ['application/json', 'text/plain'] }
          },
          additionalProperties: false
        } } } },
        responses: {
          '201': { description: 'Artifact metadata.' },
          '400': { description: 'Artifact metadata or content type is invalid.' },
          '404': { description: 'Run not found.' },
          '409': { description: 'Tool call already has a different artifact.' },
          '413': { description: 'Request or artifact exceeds its configured size limit.' }
        }
      }
    },
    '/api/v1/runs/{runId}/tool-result-artifacts/{artifactId}': {
      get: {
        tags: ['runs'], summary: 'Read a short-lived full redacted tool result',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'path', name: 'artifactId', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'Redacted tool result artifact.',
            headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
            content: {
              'application/json': { schema: {} },
              'text/plain': { schema: { type: 'string' } }
            }
          },
          '404': { description: 'Artifact unavailable or expired.' }
        }
      }
    }
  };
}
