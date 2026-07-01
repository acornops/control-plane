import { EXAMPLE_RUN_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const scheduleSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    workspaceId: { type: 'string', format: 'uuid' },
    workflowId: { type: 'string' },
    workflowVersion: { type: 'integer' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['enabled', 'paused'] },
    cron: { type: 'string', example: '0 9 * * 1-5' },
    timezone: { type: 'string', example: 'UTC' },
    inputDefaults: { type: 'object', additionalProperties: true },
    approvedContextGrants: { type: 'array', items: { type: 'string' } },
    nextRunAt: { type: 'string', format: 'date-time' },
    lastRunAt: { type: 'string', format: 'date-time' },
    lastStatus: { type: 'string', enum: ['dispatched', 'failed', 'auto_paused', 'skipped'] },
    lastError: { type: 'string' }
  }
};

const approvalInboxRowSchema = {
  type: 'object',
  properties: {
    approvalId: { type: 'string', format: 'uuid' },
    runId: { type: 'string', format: 'uuid', example: EXAMPLE_RUN_ID },
    source: { type: 'string', enum: ['target_tool', 'workflow_gate'] },
    workflowId: { type: 'string' },
    targetId: { type: 'string', format: 'uuid' },
    targetType: { type: 'string' },
    summary: { type: 'string' },
    toolName: { type: 'string' },
    requestedBy: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    decidedBy: { type: 'string' },
    decidedAt: { type: 'string', format: 'date-time' },
    requestedAt: { type: 'string', format: 'date-time' }
  }
};

export function buildWorkflowPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/workflow-schedules': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow schedules for a workspace',
        description: 'Returns control-plane-owned workflow schedules and summary metrics. Requires read_workspace_data.',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } }
        ],
        responses: {
          '200': {
            description: 'Workflow schedule list and summary.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: scheduleSchema },
                    summary: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        active: { type: 'integer' },
                        paused: { type: 'integer' },
                        approvalGated: { type: 'integer' },
                        nextRunAt: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create workflow schedule',
        description: 'Creates a scheduled workflow automation. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workflowId', 'name', 'cron', 'timezone'],
                properties: {
                  workflowId: { type: 'string' },
                  name: { type: 'string' },
                  enabled: { type: 'boolean' },
                  cron: { type: 'string' },
                  timezone: { type: 'string' },
                  inputDefaults: { type: 'object', additionalProperties: true },
                  approvedContextGrants: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Workflow schedule created.',
            content: { 'application/json': { schema: { type: 'object', properties: { schedule: scheduleSchema } } } }
          }
        }
      }
    },
    '/api/v1/workflow-schedules/{scheduleId}': {
      patch: {
        tags: ['workflows'],
        summary: 'Update workflow schedule',
        description: 'Updates schedule cadence, enabled state, workflow, grants, or defaults. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'scheduleId', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  workspaceId: { type: 'string', format: 'uuid' },
                  workflowId: { type: 'string' },
                  name: { type: 'string' },
                  enabled: { type: 'boolean' },
                  cron: { type: 'string' },
                  timezone: { type: 'string' },
                  inputDefaults: { type: 'object', additionalProperties: true },
                  approvedContextGrants: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Workflow schedule updated.',
            content: { 'application/json': { schema: { type: 'object', properties: { schedule: scheduleSchema } } } }
          }
        }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete workflow schedule',
        security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'scheduleId', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Workflow schedule deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/approvals': {
      get: {
        tags: ['workflows'],
        summary: 'List workspace approval inbox',
        description: 'Normalizes target write-tool approvals and workflow approval gates into a single workspace inbox. Decisions remain on the run-scoped approval decision endpoint.',
        security: [{ userSession: [] }],
        parameters: [
          { in: 'path', name: 'workspaceId', required: true, schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID } },
          { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['pending', 'decided', 'all'], default: 'pending' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Unified approval inbox page.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: approvalInboxRowSchema },
                    nextCursor: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
