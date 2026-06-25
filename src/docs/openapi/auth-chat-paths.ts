export function buildAuthChatPaths(): Record<string, unknown> {
  return {
    '/api/v1/auth/external-integrations/link': {
      post: {
        tags: ['auth'],
        summary: 'Create an external integration account link token',
        description: 'Client-token endpoint for a registered external integration client. The client submits its own stable external user id and receives a management-console URL that starts browser authentication.',
        security: [{ externalIntegrationClientToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['externalUserId'],
                additionalProperties: false,
                properties: {
                  externalUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'slack-user-id' },
                  externalDisplayName: { type: 'string', minLength: 1, maxLength: 120, example: 'John Tan' }
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
          '401': { description: 'Missing or invalid external integration client token.' }
        }
      }
    },
    '/api/v1/auth/external-integrations/resolve': {
      post: {
        tags: ['auth'],
        summary: 'Resolve an external user link',
        description: 'Client-token endpoint for a registered external integration client. The client submits its own stable external user id and receives whether that identity is durably linked to an AcornOps user.',
        security: [{ externalIntegrationClientToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['externalUserId'],
                additionalProperties: false,
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
          '401': { description: 'Missing or invalid external integration client token.' }
        }
      }
    },
    '/api/v1/auth/external-integrations/link/preview': {
      post: {
        tags: ['auth'],
        summary: 'Preview an external integration account link',
        description: 'Authenticated browser-session endpoint used by the management console to display safe consent metadata before explicit approval.',
        security: [{ userSession: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                additionalProperties: false,
                properties: {
                  token: { type: 'string', minLength: 1, maxLength: 256, example: 'intlink_random_abc123' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Safe external integration link consent metadata.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkPreview' }
              }
            }
          },
          '400': { description: 'Invalid external integration link preview payload.' },
          '401': { description: 'User session required.' },
          '410': { description: 'External integration link token is expired, consumed, invalidated, or unavailable.' }
        }
      }
    },
    '/api/v1/auth/external-integrations/link/complete': {
      post: {
        tags: ['auth'],
        summary: 'Complete an external integration account link',
        description: 'Authenticated browser-session endpoint used by the management console after password or OIDC sign-in and explicit user approval. It consumes a valid short-lived external integration link token and binds the external user id to the signed-in AcornOps user.',
        security: [{ userSession: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                additionalProperties: false,
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
    },
    '/api/v1/auth/external-integrations/links': {
      get: {
        tags: ['auth'],
        summary: 'List linked external integrations',
        description: 'Authenticated browser-session endpoint returning active external integration links for the signed-in user.',
        security: [{ userSession: [] }],
        responses: {
          '200': {
            description: 'Active external integration links.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkList' }
              }
            }
          },
          '401': { description: 'User session required.' }
        }
      }
    },
    '/api/v1/auth/external-integrations/links/unlink': {
      post: {
        tags: ['auth'],
        summary: 'Unlink an external integration account',
        description: 'Authenticated browser-session endpoint that revokes one active external integration link owned by the signed-in user.',
        security: [{ userSession: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['integrationClientId', 'provider', 'externalUserId'],
                additionalProperties: false,
                properties: {
                  integrationClientId: { type: 'string' },
                  provider: { type: 'string' },
                  externalUserId: { type: 'string', minLength: 1, maxLength: 128 }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'External integration link revoked.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkRevocation' }
              }
            }
          },
          '400': { description: 'Invalid unlink payload.' },
          '401': { description: 'User session required.' },
          '404': { description: 'External integration link not found.' }
        }
      }
    },
    '/api/v1/auth/external-integrations/revoke': {
      post: {
        tags: ['auth'],
        summary: 'Revoke an external integration account link',
        description: 'Client-token endpoint for a registered external integration client to revoke one identity link scoped to that client.',
        security: [{ externalIntegrationClientToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['externalUserId'],
                additionalProperties: false,
                properties: {
                  externalUserId: { type: 'string', minLength: 1, maxLength: 128, example: 'slack-user-id' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'External integration link revoked.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExternalIntegrationLinkRevocation' }
              }
            }
          },
          '400': { description: 'Invalid external identity payload.' },
          '401': { description: 'Missing or invalid external integration client token.' },
          '404': { description: 'External integration link not found.' }
        }
      }
    }
  };
}
