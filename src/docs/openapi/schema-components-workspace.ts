import {
  dateTime,
  JsonSchema,
  jsonObject,
  pageOf,
  schemaRef,
  statusResponse,
  stringArray,
  uuid
} from './schema-types.js';
import { userSchema, workspacePermissionsSchema } from './schema-components-common.js';

export function buildAuthWorkspaceSchemas(): Record<string, JsonSchema> {
  return {
    GenericAccepted: statusResponse('Run'),
    AuthConfig: {
      type: 'object',
      required: ['oidcEnabled', 'passwordAuthEnabled', 'passwordSignupEnabled', 'passwordEmailVerificationRequired', 'passwordResetEnabled'],
      properties: {
        oidcEnabled: { type: 'boolean' },
        oidcProviderName: { type: 'string' },
        passwordAuthEnabled: { type: 'boolean' },
        passwordSignupEnabled: { type: 'boolean' },
        passwordEmailVerificationRequired: { type: 'boolean' },
        passwordResetEnabled: { type: 'boolean' }
      }
    },
    CsrfToken: {
      type: 'object',
      required: ['csrfToken'],
      properties: { csrfToken: { type: 'string' } }
    },
    AuthSessionResponse: {
      type: 'object',
      required: ['user'],
      properties: {
        user: userSchema,
        status: { type: 'string', enum: ['authenticated', 'verification_required'] },
        verificationRequired: { type: 'boolean' }
      },
      additionalProperties: true
    },
    OidcLinkStartResponse: {
      type: 'object',
      required: ['authorizationUrl'],
      properties: { authorizationUrl: { type: 'string', format: 'uri' } }
    },
    ExternalIntegrationLinkCreation: {
      type: 'object',
      required: ['linkUrl', 'expiresAt'],
      properties: {
        linkUrl: { type: 'string', format: 'uri' },
        expiresAt: dateTime
      }
    },
    ExternalIntegrationLinkCompletion: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['linked'] }
      }
    },
    ExternalIntegrationLinkResolution: {
      oneOf: [
        {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['unlinked'] }
          }
        },
        {
          type: 'object',
          required: ['status', 'user', 'link'],
          properties: {
            status: { type: 'string', enum: ['linked'] },
            user: {
              type: 'object',
              required: ['id', 'displayName', 'email'],
              properties: {
                id: uuid,
                displayName: { type: 'string' },
                email: { type: 'string', format: 'email' }
              }
            },
            link: {
              type: 'object',
              required: ['linkedAt', 'lastAuthenticatedAt', 'expiresAt'],
              properties: {
                linkedAt: dateTime,
                lastAuthenticatedAt: dateTime,
                expiresAt: dateTime
              }
            }
          }
        }
      ]
    },
    AuthMethods: {
      type: 'object',
      properties: {
        methods: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['password', 'oidc'] },
              linkedAt: dateTime
            },
            additionalProperties: true
          }
        },
        canChangePassword: { type: 'boolean' },
        canConnectSso: { type: 'boolean' }
      },
      additionalProperties: true
    },
    Jwks: {
      type: 'object',
      required: ['keys'],
      properties: { keys: { type: 'array', items: jsonObject } }
    },
    Workspace: {
      type: 'object',
      required: ['id', 'name', 'role', 'permissions'],
      properties: {
        id: uuid,
        name: { type: 'string' },
        role: { type: 'string' },
        permissions: workspacePermissionsSchema,
        currentUserRoleTemplate: schemaRef('WorkspaceRoleTemplate'),
        memberCount: { type: 'integer' },
        clusterCount: { type: 'integer' },
        virtualMachineCount: { type: 'integer' },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WorkspacePage: pageOf('Workspace'),
    WorkspaceRoleTemplate: {
      type: 'object',
      required: ['key', 'displayName', 'kind', 'capabilities', 'protected', 'sortOrder'],
      properties: {
        key: { type: 'string' },
        displayName: { type: 'string' },
        description: { type: 'string' },
        kind: { type: 'string', enum: ['built_in', 'custom'] },
        capabilities: stringArray,
        protected: { type: 'boolean' },
        sortOrder: { type: 'integer' }
      },
      additionalProperties: true
    },
    WorkspaceRoleCatalog: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('WorkspaceRoleTemplate') } }
    },
    WorkspaceAiProviderStatus: {
      type: 'object',
      required: ['provider', 'configured', 'enabled'],
      properties: {
        provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini'] },
        configured: { type: 'boolean' },
        enabled: { type: 'boolean' }
      }
    },
    WorkspaceAiSettings: {
      type: 'object',
      required: [
        'workspaceId',
        'defaultProvider',
        'defaultModel',
        'reasoningSummaryMode',
        'reasoningEffort',
        'allowedReasoningSummaryModes',
        'allowedReasoningEfforts',
        'reasoningSummariesEnabled',
        'allowedProviders',
        'allowedModels',
        'providers'
      ],
      properties: {
        workspaceId: uuid,
        defaultProvider: { type: 'string', enum: ['openai', 'anthropic', 'gemini'] },
        defaultModel: { type: 'string' },
        reasoningSummaryMode: { type: 'string', enum: ['off', 'auto', 'concise', 'detailed'] },
        reasoningEffort: { type: 'string', enum: ['default', 'low', 'medium', 'high'] },
        allowedReasoningSummaryModes: { type: 'array', items: { type: 'string', enum: ['off', 'auto', 'concise', 'detailed'] } },
        allowedReasoningEfforts: { type: 'array', items: { type: 'string', enum: ['default', 'low', 'medium', 'high'] } },
        reasoningSummariesEnabled: { type: 'boolean' },
        allowedProviders: { type: 'array', items: { type: 'string', enum: ['openai', 'anthropic', 'gemini'] } },
        allowedModels: stringArray,
        providers: { type: 'array', items: schemaRef('WorkspaceAiProviderStatus') }
      },
      additionalProperties: false
    },
    WorkspaceMember: {
      type: 'object',
      required: ['workspaceId', 'userId', 'role'],
      properties: {
        workspaceId: uuid,
        userId: uuid,
        email: { type: 'string', format: 'email' },
        displayName: { type: 'string' },
        role: { type: 'string' },
        roleTemplate: schemaRef('WorkspaceRoleTemplate'),
        joinedAt: dateTime
      },
      additionalProperties: true
    },
    WorkspaceMemberPage: pageOf('WorkspaceMember'),
    WorkspaceInvitation: {
      type: 'object',
      required: ['id', 'workspaceId', 'email', 'role', 'status'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        email: { type: 'string', format: 'email' },
        role: { type: 'string' },
        roleTemplate: schemaRef('WorkspaceRoleTemplate'),
        status: { type: 'string' },
        token: { type: 'string', description: 'Returned only at creation time.' },
        expiresAt: dateTime,
        createdAt: dateTime
      },
      additionalProperties: true
    },
    WorkspaceInvitationPage: pageOf('WorkspaceInvitation'),
    WorkspaceInvitationCreated: {
      allOf: [schemaRef('WorkspaceInvitation')],
      description: 'Invitation response. Includes the raw invitation token once.'
    },
    WorkspaceAuditEvent: {
      type: 'object',
      required: ['id', 'workspaceId', 'category', 'eventType', 'operation', 'actor', 'object', 'summary', 'metadata', 'occurredAt'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        category: { type: 'string' },
        eventType: { type: 'string' },
        operation: { type: 'string', enum: ['read', 'write'] },
        actor: jsonObject,
        object: jsonObject,
        summary: { type: 'string' },
        metadata: jsonObject,
        occurredAt: dateTime
      },
      additionalProperties: true
    },
    WorkspaceAuditEventPage: pageOf('WorkspaceAuditEvent')
  };
}
