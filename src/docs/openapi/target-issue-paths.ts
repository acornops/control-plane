import { EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const externalUserHeader = {
  in: 'header',
  name: 'x-acornops-external-user-id',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Required only for external integration client-token requests. Must identify a linked external integration user.'
};

export function buildTargetIssuePaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/auto-triage': {
      get: {
        tags: ['workspaces'],
        summary: 'Get target auto-triage settings and effective readiness',
        description: 'Browser callers receive edit capability when authorized. External integration callers with read_workspace_data receive the complete effective configuration read-only.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: {
          '200': { description: 'Persisted settings, effective write behavior, readiness, edit capability, and eligible current issue count.' }
        }
      },
      patch: {
        tags: ['workspaces'],
        summary: 'Save target auto-triage settings with optimistic revision checking',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'expectedRevision',
                  'enabled',
                  'minimumSeverity',
                  'writeMode',
                  'additionalInstructions'
                ],
                properties: {
                  expectedRevision: { type: 'integer', minimum: 0 },
                  enabled: { type: 'boolean' },
                  minimumSeverity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                  writeMode: { type: 'string', enum: ['follow_target', 'read_only', 'approval_required', 'full_write'] },
                  additionalInstructions: { type: 'string', maxLength: 4000 },
                  namespaceInclude: {
                    type: 'array',
                    default: [],
                    maxItems: 100,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 63,
                      pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
                    }
                  },
                  namespaceExclude: {
                    type: 'array',
                    default: [],
                    maxItems: 100,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 63,
                      pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
                    }
                  },
                  includeClusterScopedIssues: { type: 'boolean', default: true }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          '200': { description: 'Saved settings with effective behavior and readiness.' },
          '409': { description: 'Settings revision conflict.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/auto-triage/investigations': {
      post: {
        tags: ['workspaces'],
        summary: 'Explicitly queue currently eligible target issue lifecycles',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['expectedSettingsRevision'],
                properties: { expectedSettingsRevision: { type: 'integer', minimum: 1 } },
                additionalProperties: false
              }
            }
          }
        },
        responses: { '202': { description: 'Idempotent queue counts.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/issues/{issueId}/automatic-investigation': {
      post: {
        tags: ['workspaces'],
        summary: 'Idempotently start or retry the automatic investigation for the current issue lifecycle',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'issueId', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': { description: 'Existing lifecycle investigation activity.' },
          '202': { description: 'Eligible lifecycle investigation queued for initial start or retry.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/issues/summary': {
      get: {
        tags: ['workspaces'],
        summary: 'Summarize active durable operational issues for a target',
        description: 'Browser callers use the session cookie. External integration callers may use the external integration client token plus x-acornops-external-user-id when the linked user and bot allowlist grant read_workspace_data.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } }
        ],
        responses: {
          '200': {
            description: 'Active issue summary counts.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TargetIssueSummary' }
              }
            }
          }
        }
      }
    }
  };
}
