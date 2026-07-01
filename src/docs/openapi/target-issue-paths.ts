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
