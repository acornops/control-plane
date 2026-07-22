import {
  EXAMPLE_TARGET_ID,
  EXAMPLE_WORKSPACE_ID
} from '../../constants/dev-defaults.js';

export function buildTargetChatActivityPaths(externalUserHeader: Record<string, unknown>): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity': {
      get: {
        tags: ['sessions'],
        summary: 'List recent target chat activity',
        description: 'Returns recent non-deleted, non-expired troubleshooting sessions with message/run activity for the target. Requires target read access, not chat creation permission.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'windowSeconds', required: false, schema: { type: 'integer', minimum: 60, maximum: 3600, default: 300 } }
        ],
        responses: {
          '200': {
            description: 'Recent activity payload with target metadata, windowSeconds, generatedAt, and recentActivity rows including owner display metadata, last run, active run, and write-capable activity flags.'
          }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/chat-activity/stream': {
      get: {
        tags: ['sessions'],
        summary: 'Stream target chat activity',
        description: 'Long-lived SSE stream for browser-facing target chat activity. Frames use event: chat_activity, id: activity event id, and JSON data with resource identifiers. Supports Last-Event-ID and the optional after query parameter for resume replay; connections without a resume cursor are live-only.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'path', name: 'targetId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_TARGET_ID } },
          { in: 'query', name: 'after', required: false, schema: { type: 'string', example: '42' } },
          { in: 'header', name: 'Last-Event-ID', required: false, schema: { type: 'string', example: '42' } }
        ],
        responses: {
          '200': { description: 'SSE stream of target chat activity events.' }
        }
      }
    }
  };
}
