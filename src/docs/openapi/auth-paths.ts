import { EXAMPLE_TRACE_ID } from '../../constants/dev-defaults.js';

export function buildAuthPaths(exampleReturnTo: string, exampleRedirectUri: string): Record<string, unknown> {
  return {
    '/api/v1/auth/oidc/login': {
        get: {
          tags: ['auth'],
          summary: 'Start OIDC login flow',
          parameters: [
            {
              in: 'query',
              name: 'redirect_uri',
              required: false,
              schema: { type: 'string', format: 'uri', example: exampleRedirectUri }
            },
            {
              in: 'query',
              name: 'return_to',
              required: false,
              schema: { type: 'string', format: 'uri', example: exampleReturnTo }
            }
          ],
          responses: {
            '302': { description: 'Redirects to OIDC provider authorization endpoint.' }
          }
        }
      },
      '/api/v1/auth/oidc/callback': {
        get: {
          tags: ['auth'],
          summary: 'OIDC callback endpoint',
          parameters: [
            { in: 'query', name: 'code', required: true, schema: { type: 'string', example: 'oidc-auth-code' } },
            { in: 'query', name: 'state', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TRACE_ID } }
          ],
          responses: {
            '302': { description: 'Session created and browser redirected to return_to URL, or SSO link completed.' },
            '200': { description: 'Session created and user returned.' },
            '400': { description: 'Missing callback parameters, invalid state, or missing OIDC email.' },
            '403': { description: 'OIDC email was explicitly unverified while verified email is required.' },
            '409': { description: 'Existing password user must explicitly connect SSO, or OIDC identity is already linked.' }
          }
        }
      },
      '/api/v1/auth/config': {
        get: {
          tags: ['auth'],
          summary: 'Get runtime auth capabilities for the management console',
          responses: {
            '200': {
              description: 'Enabled auth methods and display metadata.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'oidcEnabled',
                      'oidcProviderName',
                      'passwordAuthEnabled',
                      'passwordSignupEnabled',
                      'passwordEmailVerificationRequired',
                      'passwordResetEnabled'
                    ],
                    properties: {
                      oidcEnabled: { type: 'boolean', example: true },
                      oidcProviderName: { type: 'string', example: 'oidc' },
                      passwordAuthEnabled: { type: 'boolean', example: true },
                      passwordSignupEnabled: { type: 'boolean', example: true },
                      passwordEmailVerificationRequired: { type: 'boolean', example: true },
                      passwordResetEnabled: { type: 'boolean', example: true }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/v1/auth/csrf': {
        get: {
          tags: ['auth'],
          summary: 'Issue a CSRF token for browser mutating requests',
          responses: {
            '200': {
              description: 'Signed CSRF token. The same value is also set in a readable SameSite cookie.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['csrfToken'],
                    properties: {
                      csrfToken: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/v1/auth/password/login': {
        post: {
          tags: ['auth'],
          summary: 'Create a session using username/email and password',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['identifier', 'password'],
                  properties: {
                    identifier: { type: 'string', example: 'dev' },
                    password: { type: 'string', format: 'password', example: 'devpass' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Session cookie set and user returned.' },
            '403': { description: 'Password account email has not been verified. Returns EMAIL_VERIFICATION_REQUIRED.' },
            '401': { description: 'Invalid credentials.' },
            '429': { description: 'Too many login attempts.' }
          }
        }
      },
      '/api/v1/auth/password/signup': {
        post: {
          tags: ['auth'],
          summary: 'Create a user with password credentials',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'username', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@acornops.local' },
                    username: { type: 'string', example: 'dev' },
                    displayName: { type: 'string', example: 'Dev User' },
                    password: { type: 'string', format: 'password', minLength: 15, maxLength: 1024, example: 'dev-password-12345' }
                  }
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'User created. Returns either an immediate session or verification_required when email verification is required.'
            },
            '400': { description: 'Invalid signup payload.' },
            '409': { description: 'Email or username already exists.' },
            '503': { description: 'Verification email could not be delivered. Account remains pending verification.' }
          }
        }
      },
      '/api/v1/auth/password/verify-email': {
        post: {
          tags: ['auth'],
          summary: 'Verify a password-account email address and create a session',
          description: 'Verification tokens are bearer secrets. Browser clients must send them only over HTTPS outside local development.',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: {
                    token: { type: 'string', example: 'base64url-verification-token' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Email verified, session cookie set, and user returned with status=verified.' },
            '400': { description: 'Token is invalid, already used, or malformed.' },
            '410': { description: 'Token expired. Returns EMAIL_VERIFICATION_TOKEN_EXPIRED.' }
          }
        }
      },
      '/api/v1/auth/password/resend-verification': {
        post: {
          tags: ['auth'],
          summary: 'Request another verification email',
          description: 'The response is enumeration-safe for unknown, already verified, and pending accounts.',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@acornops.local' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Generic success or throttled response with optional resendAfterSeconds.' },
            '400': { description: 'Invalid email payload.' }
          }
        }
      },
      '/api/v1/auth/password/forgot': {
        post: {
          tags: ['auth'],
          summary: 'Request a password reset email',
          description: 'The response is enumeration-safe for unknown, OIDC-only, verified password, and pending password accounts. Only password-backed users receive a token.',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@acornops.local' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Generic success or throttled response with optional resendAfterSeconds.' },
            '400': { description: 'Invalid email payload.' },
            '403': { description: 'Password reset is disabled.' }
          }
        }
      },
      '/api/v1/auth/password/reset': {
        post: {
          tags: ['auth'],
          summary: 'Set a new password using a password reset token',
          description: 'Reset tokens are bearer secrets. Successful reset verifies the account email, consumes outstanding reset and verification tokens for the same user/email, and revokes browser sessions.',
          parameters: [
            {
              name: 'x-csrf-token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'CSRF token returned by /api/v1/auth/csrf and mirrored in the CSRF cookie.'
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'password'],
                  properties: {
                    token: { type: 'string', example: 'base64url-reset-token' },
                    password: { type: 'string', format: 'password', minLength: 15, maxLength: 1024 }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Password updated. No new session is created.' },
            '400': { description: 'Invalid token, malformed payload, or password policy violation.' },
            '403': { description: 'Password reset is disabled.' },
            '410': { description: 'Token expired. Returns PASSWORD_RESET_TOKEN_EXPIRED.' }
          }
        }
      },
      '/api/v1/auth/password/change': {
        post: {
          tags: ['auth'],
          summary: 'Change the local password for a password-backed account',
          security: [{ userSession: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currentPassword', 'newPassword'],
                  properties: {
                    currentPassword: { type: 'string', format: 'password' },
                    newPassword: { type: 'string', format: 'password', minLength: 15, maxLength: 1024 }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Password changed, session rotated, and other sessions revoked.' },
            '400': { description: 'Invalid payload or password policy violation.' },
            '401': { description: 'Current password is incorrect.' },
            '403': { description: 'Account has no local password credential.' },
            '429': { description: 'Too many attempts.' }
          }
        }
      },
      '/api/v1/auth/oidc/link/start': {
        post: {
          tags: ['auth'],
          summary: 'Start explicit SSO linking for an existing password-backed account',
          security: [{ userSession: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currentPassword'],
                  properties: {
                    currentPassword: { type: 'string', format: 'password' },
                    returnTo: { type: 'string', example: '/settings' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Returns an OIDC authorization URL for the browser to follow.' },
            '401': { description: 'Current password is incorrect.' },
            '403': { description: 'Only password-backed accounts can connect SSO.' },
            '409': { description: 'SSO is already connected.' },
            '429': { description: 'Too many attempts.' }
          }
        }
      },
      '/api/v1/auth/dev-login': {
        post: {
          tags: ['auth'],
          summary: 'Development login shortcut (non-production only)',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@acornops.local' },
                    name: { type: 'string', example: 'Dev User' }
                  },
                  example: {
                    email: 'dev@acornops.local',
                    name: 'Dev User'
                  }
                }
              }
            }
          },
          responses: { '200': { description: 'Dev user session created.' } }
        }
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Log out current session',
          security: [{ userSession: [] }],
          responses: { '200': { description: 'Session cleared.' } }
        }
      },
      '/api/v1/me': {
        get: {
          tags: ['auth'],
          summary: 'Get current authenticated user',
          security: [{ userSession: [] }],
          responses: {
            '200': {
              description: 'Current user details, including quota.workspaceMemberships.{used,limit}.'
            },
            '401': { description: 'No user session.' }
          }
        }
      },
      '/api/v1/auth/methods': {
        get: {
          tags: ['auth'],
          summary: 'List current user authentication methods and account security capabilities',
          security: [{ userSession: [] }],
          responses: {
            '200': {
              description: 'Authentication methods for the current user. OIDC subjects are never returned.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['methods', 'capabilities'],
                    properties: {
                      methods: {
                        type: 'array',
                        items: {
                          oneOf: [
                            {
                              type: 'object',
                              required: ['type', 'username', 'lastChangedAt'],
                              properties: {
                                type: { const: 'password' },
                                username: { type: 'string' },
                                lastChangedAt: { type: 'string', format: 'date-time' },
                                lastLoginAt: { type: 'string', format: 'date-time' }
                              }
                            },
                            {
                              type: 'object',
                              required: ['type', 'provider', 'emailAtLinkTime', 'linkedAt'],
                              properties: {
                                type: { const: 'oidc' },
                                provider: { type: 'string' },
                                emailAtLinkTime: { type: 'string', format: 'email' },
                                linkedAt: { type: 'string', format: 'date-time' },
                                lastLoginAt: { type: 'string', format: 'date-time' }
                              }
                            }
                          ]
                        }
                      },
                      capabilities: {
                        type: 'object',
                        required: ['canChangePassword', 'canLinkOidc', 'canAddPassword'],
                        properties: {
                          canChangePassword: { type: 'boolean' },
                          canLinkOidc: { type: 'boolean' },
                          canAddPassword: { type: 'boolean' }
                        }
                      }
                    }
                  }
                }
              }
            },
            '401': { description: 'No user session.' }
          }
        }
      },
      '/api/v1/auth/jwks.json': {
        get: {
          tags: ['auth'],
          summary: 'JWKS used by llm-gateway to validate run-scoped JWTs',
          responses: { '200': { description: 'JWKS document.' } }
        }
      }
  };
}
