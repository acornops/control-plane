import { EXAMPLE_TARGET_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

export function buildTargetIssuePaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/targets/{targetId}/issues/summary': {
      get: {
        tags: ['workspaces'],
        summary: 'Summarize active durable operational issues for a target',
        security: [{ userSession: [] }],
        parameters: [
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
