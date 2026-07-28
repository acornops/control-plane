import { dateTime, type JsonSchema, schemaRef, uuid } from './schema-types.js';

export function buildAutoTriageSchemas(): Record<string, JsonSchema> {
  return {
    AutomaticInvestigationSummary: {
      type: 'object',
      required: ['issueId', 'lifecycleVersion', 'state', 'updatedAt', 'canRetry'],
      properties: {
        issueId: uuid,
        lifecycleVersion: { type: 'integer', minimum: 1 },
        state: {
          type: 'string',
          enum: ['queued', 'investigating', 'awaiting_approval', 'findings_ready', 'failed', 'cancelled', 'deleted']
        },
        sessionId: uuid,
        runId: uuid,
        updatedAt: dateTime,
        errorCode: { type: 'string', maxLength: 64 },
        canRetry: { type: 'boolean' }
      },
      additionalProperties: false
    },
    AutoTriageEffectiveBehavior: {
      type: 'object',
      required: [
        'requestedWriteMode',
        'effectiveToolMode',
        'confirmationRequiredForWrite',
        'targetCeilingApplied',
        'targetSupportsWrite',
        'summary'
      ],
      properties: {
        requestedWriteMode: { type: 'string', enum: ['follow_target', 'read_only', 'approval_required', 'full_write'] },
        effectiveToolMode: { type: 'string', enum: ['read_only', 'read_write'] },
        confirmationRequiredForWrite: { type: 'boolean' },
        targetCeilingApplied: { type: 'boolean' },
        targetSupportsWrite: { type: 'boolean' },
        summary: {
          type: 'string',
          enum: ['read_only', 'approval_required', 'automatic_write', 'reduced_to_approval', 'agent_read_only']
        }
      },
      additionalProperties: false
    },
    TargetAutoTriageSettings: {
      type: 'object',
      required: [
        'workspaceId',
        'targetId',
        'enabled',
        'minimumSeverity',
        'writeMode',
        'additionalInstructions',
        'revision',
        'canEdit',
        'eligibleCurrentIssueCount',
        'effectiveBehavior',
        'readiness'
      ],
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        enabled: { type: 'boolean' },
        minimumSeverity: { type: 'string', enum: ['critical', 'warning', 'info'] },
        writeMode: { type: 'string', enum: ['follow_target', 'read_only', 'approval_required', 'full_write'] },
        additionalInstructions: { type: 'string', maxLength: 4000 },
        revision: { type: 'integer', minimum: 0 },
        canEdit: { type: 'boolean' },
        eligibleCurrentIssueCount: { type: 'integer', minimum: 0 },
        effectiveBehavior: schemaRef('AutoTriageEffectiveBehavior'),
        readiness: {
          type: 'object',
          required: ['status', 'reasons', 'unavailableOptionalMcpToolCount'],
          properties: {
            status: { type: 'string', enum: ['ready', 'needs_setup', 'temporarily_unavailable'] },
            reasons: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'ai_provider_credentials_missing',
                  'target_agent_disconnected',
                  'no_diagnostic_tools',
                  'mcp_tools_need_setup',
                  'optional_mcp_tools_unavailable'
                ]
              }
            },
            unavailableOptionalMcpToolCount: { type: 'integer', minimum: 0 }
          },
          additionalProperties: false
        },
        updatedBy: { type: 'string' },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: false
    },
    AutoTriageBulkStartResult: {
      type: 'object',
      required: ['queuedCount', 'alreadyExistsCount', 'skippedCount'],
      properties: {
        queuedCount: { type: 'integer', minimum: 0 },
        alreadyExistsCount: { type: 'integer', minimum: 0 },
        skippedCount: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    }
  };
}
