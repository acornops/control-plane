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
        actor: {
          type: 'object',
          properties: {
            issuer: { type: 'string' },
            subject: { type: 'string' },
            email: { type: 'string' },
            displayName: { type: 'string' },
            roles: stringArray,
            scopes: stringArray,
            authenticatedAt: dateTime
          }
        },
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
        planCatalog: jsonObject,
        roleTemplateKeys: stringArray,
        authModes: jsonObject,
        retention: {
          type: 'object',
          properties: {
            conversationDays: { type: 'integer' },
            webhookHistoryDays: { type: 'integer' },
            workspaceAuditDays: { type: 'integer' },
            targetMetricHistoryDays: { type: 'integer' }
          },
          additionalProperties: true
        },
        auditLogging: jsonObject,
        runPolicy: jsonObject,
        featureFlags: jsonObject
      },
      additionalProperties: true
    },
    AdminWorkspace: {
      allOf: [
        schemaRef('Workspace'),
        {
          type: 'object',
          required: ['virtualMachineCount', 'lifecycleStatus'],
          properties: {
            virtualMachineCount: { type: 'integer', minimum: 0 },
            lifecycleStatus: { type: 'string', enum: ['active', 'suspended'] },
            suspendedAt: dateTime
          }
        }
      ],
      description: 'Support-safe workspace detail.'
    },
    AdminWorkspacePage: pageOf('AdminWorkspace'),
    AdminWorkspaceMemberPage: pageOf('WorkspaceMember'),
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
      required: ['id', 'action', 'outcome', 'requestId', 'metadata', 'occurredAt'],
      properties: {
        id: uuid,
        adminTokenId: { type: 'string' },
        adminActorIssuer: { type: 'string' },
        adminActorSubject: { type: 'string' },
        adminActorEmail: { type: 'string' },
        adminActorDisplayName: { type: 'string' },
        adminActorRole: { type: 'string', enum: ['platform-admin', 'platform-admin-viewer', 'platform-admin-auditor'] },
        authenticationTime: dateTime,
        action: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        workspaceId: { type: 'string' },
        targetType: { type: 'string' },
        targetId: { type: 'string' },
        subjectType: { type: 'string' },
        subjectId: { type: 'string' },
        reason: { type: 'string' },
        requestId: { type: 'string' },
        sourceIpHash: { type: 'string' },
        userAgent: { type: 'string' },
        metadata: jsonObject,
        occurredAt: dateTime
      },
      additionalProperties: true
    },
    AdminAuditEventPage: pageOf('AdminAuditEvent')
  };
}
