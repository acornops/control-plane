import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';
import { runSchema, targetSummarySchema, userSchema } from './schema-components-common.js';

export function buildAdminSchemas(): Record<string, JsonSchema> {
  return {
    AdminMe: {
      type: 'object',
      required: ['tokenId', 'scopes', 'adminApiEnabled'],
      properties: {
        tokenId: { type: 'string' },
        tokenName: { type: 'string' },
        scopes: stringArray,
        adminApiEnabled: { type: 'boolean' }
      },
      additionalProperties: true
    },
    AdminReadiness: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        dependencies: jsonObject,
        adminAuditWrite: { type: 'string' }
      },
      additionalProperties: true
    },
    AdminConfig: {
      type: 'object',
      properties: {
        adminApiEnabled: { type: 'boolean' },
        workspacePlans: jsonObject,
        quotas: jsonObject
      },
      additionalProperties: true
    },
    AdminWorkspace: {
      allOf: [schemaRef('Workspace')],
      description: 'Support-safe workspace detail.'
    },
    AdminWorkspacePage: pageOf('AdminWorkspace'),
    AdminUser: {
      allOf: [userSchema],
      description: 'Support-safe user detail. Password hashes, reset tokens, and OIDC subjects are never returned.'
    },
    AdminUserPage: pageOf('AdminUser'),
    AdminTarget: {
      allOf: [targetSummarySchema],
      description: 'Support-safe target summary.'
    },
    AdminTargetPage: pageOf('AdminTarget'),
    AdminTargetAgent: {
      type: 'object',
      properties: {
        target: schemaRef('AdminTarget'),
        agent: jsonObject
      },
      additionalProperties: true
    },
    AdminRun: {
      allOf: [runSchema],
      description: 'Support-safe run detail without prompts or full tool arguments.'
    },
    AdminRunPage: pageOf('AdminRun'),
    AdminMutationRequest: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', minLength: 3, maxLength: 500 },
        ticketRef: { type: 'string' }
      },
      additionalProperties: true
    },
    AdminMutationResult: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        before: jsonObject,
        after: jsonObject,
        result: jsonObject,
        revokedSessionCount: { type: 'integer' },
        synced: { type: 'array', items: jsonObject },
        failures: { type: 'array', items: jsonObject },
        agentKey: { type: 'string', description: 'Returned only by emergency agent-key rotation.' },
        installInstructions: schemaRef('InstallInstructions')
      },
      additionalProperties: true
    },
    AdminAuditEvent: {
      type: 'object',
      properties: {
        id: uuid,
        tokenId: { type: 'string' },
        scope: { type: 'string' },
        method: { type: 'string' },
        path: { type: 'string' },
        statusCode: { type: 'integer' },
        reason: { type: 'string' },
        metadata: jsonObject,
        createdAt: dateTime
      },
      additionalProperties: true
    },
    AdminAuditEventPage: pageOf('AdminAuditEvent')
  };
}
