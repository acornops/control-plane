export function buildAuthChatPaths(): Record<string, unknown> {
  return {
    '/api/v1/auth/chat/mattermost/link': {
      post: {
        tags: ['auth'],
        summary: 'Create a Mattermost account link token',
        description: 'Service-token endpoint for the registered Mattermost bot. The bot submits the Mattermost user id observed from Mattermost and receives a management-console URL that starts browser authentication.',
        security: [{ mattermostChatServiceToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mattermostUserId'],
                properties: {
                  mattermostUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'mm-user-id' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Short-lived Mattermost account link URL for the user to open in a browser.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MattermostLinkCreation' }
              }
            }
          },
          '400': { description: 'Invalid Mattermost account link payload.' },
          '401': { description: 'Missing or invalid Mattermost chat service token.' }
        }
      }
    },
    '/api/v1/auth/chat/mattermost/resolve': {
      post: {
        tags: ['auth'],
        summary: 'Resolve a Mattermost user link',
        description: 'Service-token endpoint for the registered Mattermost bot. The bot submits the Mattermost user id observed from Mattermost and receives whether that identity is durably linked to an AcornOps user.',
        security: [{ mattermostChatServiceToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mattermostUserId'],
                properties: {
                  mattermostUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'mm-user-id' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Linked or unlinked Mattermost account status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MattermostLinkResolution' }
              }
            }
          },
          '400': { description: 'Invalid Mattermost identity payload.' },
          '401': { description: 'Missing or invalid Mattermost chat service token.' }
        }
      }
    },
    '/api/v1/auth/chat/mattermost/link/complete': {
      post: {
        tags: ['auth'],
        summary: 'Complete a Mattermost account link',
        description: 'Authenticated browser-session endpoint used by the management console after password or OIDC sign-in and explicit user approval. It consumes a valid short-lived Mattermost link token and binds the Mattermost user id to the signed-in AcornOps user.',
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                properties: {
                  token: { type: 'string', minLength: 1, maxLength: 256, example: 'mmlink_random_abc123' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Mattermost account link completed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MattermostLinkCompletion' }
              }
            }
          },
          '400': { description: 'Invalid Mattermost link completion payload.' },
          '401': { description: 'User session required.' },
          '410': { description: 'Mattermost link token is expired, consumed, invalidated, or unavailable.' }
        }
      }
    }
  };
}
