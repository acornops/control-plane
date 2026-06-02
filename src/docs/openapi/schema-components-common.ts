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
    User: userSchema
  };
}
