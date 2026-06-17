export function buildAuthChatPaths(): Record<string, unknown> {
  return {
    '/api/v1/auth/chat/integration/link': {
      post: {
        tags: ['auth'],
        summary: 'Create an external integration account link token',
        description: 'Service-token endpoint for a registered external integration client. The client submits its own stable external user id and receives a management-console URL that starts browser authentication.',
        security: [{ externalIntegrationServiceToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['externalUserId'],
                properties: {
                  externalUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'slack-user-id' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Short-lived external integration account link URL for the user to open in a browser.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkCreation' }
              }
            }
          },
          '400': { description: 'Invalid external integration account link payload.' },
          '401': { description: 'Missing or invalid external integration service token.' }
        }
      }
    },
    '/api/v1/auth/chat/integration/resolve': {
      post: {
        tags: ['auth'],
        summary: 'Resolve an external user link',
        description: 'Service-token endpoint for a registered external integration client. The client submits its own stable external user id and receives whether that identity is durably linked to an AcornOps user.',
        security: [{ externalIntegrationServiceToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['externalUserId'],
                properties: {
                  externalUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'slack-user-id' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Linked or unlinked external integration account status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkResolution' }
              }
            }
          },
          '400': { description: 'Invalid external identity payload.' },
          '401': { description: 'Missing or invalid external integration service token.' }
        }
      }
    },
    '/api/v1/auth/chat/integration/link/complete': {
      post: {
        tags: ['auth'],
        summary: 'Complete an external integration account link',
        description: 'Authenticated browser-session endpoint used by the management console after password or OIDC sign-in and explicit user approval. It consumes a valid short-lived external integration link token and binds the external user id to the signed-in AcornOps user.',
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                properties: {
                  token: { type: 'string', minLength: 1, maxLength: 256, example: 'intlink_random_abc123' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'External integration account link completed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkCompletion' }
              }
            }
          },
          '400': { description: 'Invalid external integration link completion payload.' },
          '401': { description: 'User session required.' },
          '410': { description: 'External integration link token is expired, consumed, invalidated, or unavailable.' }
        }
      }
    }
  };
}
