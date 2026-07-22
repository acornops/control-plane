import { dateTime, JsonSchema, jsonObject, schemaRef, uuid } from './schema-types.js';

export const userSchema = {
  type: 'object',
  required: ['id', 'email', 'displayName'],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string' },
    emailVerified: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime
  },
  additionalProperties: true
};

export const workspacePermissionsSchema = {
  type: 'object',
  additionalProperties: { type: 'boolean' }
};

export const targetSummarySchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'targetType', 'name'],
  properties: {
    id: uuid,
    workspaceId: uuid,
    targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
    name: { type: 'string' },
    status: { type: 'string' },
    connectionStatus: { type: 'string' },
    latestSnapshot: schemaRef('SnapshotReference'),
    summary: jsonObject,
    permissions: workspacePermissionsSchema
  },
  additionalProperties: true
};

export const runSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'sessionId', 'targetId', 'targetType', 'status'],
  properties: {
    id: uuid,
    workspaceId: uuid,
    sessionId: uuid,
    targetId: uuid,
    targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
    clusterId: uuid,
    status: { type: 'string' },
    toolAccessMode: { type: 'string', enum: ['read_only', 'read_write'] },
    createdAt: dateTime,
    startedAt: dateTime,
    completedAt: dateTime,
    cancelledAt: dateTime,
    error: jsonObject
  },
  additionalProperties: true
};

export function buildCommonSchemas(): Record<string, JsonSchema> {
  return {
    JsonObject: jsonObject,
    EmptyObject: { type: 'object', additionalProperties: false },
    ErrorResponse: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            details: {
              type: 'object',
              additionalProperties: true,
              description: 'Optional structured error details.'
            }
          }
        }
      }
    },
    McpReadinessFailure: {
      type: 'object',
      required: ['serverId', 'toolName', 'code'],
      properties: {
        serverId: { type: 'string', maxLength: 256 },
        toolName: { type: 'string', maxLength: 256 },
        code: {
          type: 'string',
          enum: [
            'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED',
            'MCP_CONNECTION_MISSING',
            'MCP_CONNECTION_ERROR',
            'MCP_CREDENTIAL_TOOL_UNAVAILABLE',
            'MCP_INSTALLATION_UNAVAILABLE',
            'MCP_REMOTE_DISABLED'
          ]
        },
        action: {
          type: 'string',
          enum: ['connect_mcp_server', 'verify_mcp_server']
        }
      },
      additionalProperties: false,
      description: 'Bounded MCP readiness metadata. Credential, identity, header, URL, and connection snapshot fields are never included.'
    },
    McpReadinessErrorResponse: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'retryable', 'details'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'MCP_CONNECTION_REQUIRED',
                'MCP_INDIVIDUAL_USER_PRINCIPAL_REQUIRED',
                'MCP_INSTALLATION_UNAVAILABLE',
                'MCP_REMOTE_DISABLED'
              ]
            },
            message: { type: 'string' },
            retryable: { type: 'boolean', enum: [false] },
            details: {
              type: 'object',
              required: ['readinessFailures'],
              properties: {
                readinessFailures: {
                  type: 'array',
                  maxItems: 20,
                  items: schemaRef('McpReadinessFailure')
                },
                action: {
                  type: 'string',
                  enum: ['connect_mcp_server', 'verify_mcp_server'],
                  description: 'Compatibility shortcut for the first failure action.'
                }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    GenericSuccess: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        status: { type: 'string' },
        message: { type: 'string' },
        resendAfterSeconds: { type: 'integer' }
      },
      additionalProperties: true
    },
    AuthLogoutResponse: {
      type: 'object',
      required: ['status', 'mode', 'redirectPath'],
      properties: {
        status: { const: 'ok' },
        mode: { type: 'string', enum: ['oidc', 'local'] },
        redirectPath: { type: 'string', pattern: '^/' }
      },
      additionalProperties: false
    },
    User: userSchema
  };
}
