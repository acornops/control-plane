import { EXAMPLE_RUN_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';
import { streamContent } from './schema-types.js';
import { buildWorkflowWebhookPaths } from './workflow-webhook-paths.js';

const workspaceIdParameter = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const workflowIdParameter = {
  in: 'path',
  name: 'workflowId',
  required: true,
  schema: { type: 'string', example: 'workflow-cluster-daily-triage' }
};

const scheduleIdParameter = {
  in: 'path',
  name: 'scheduleId',
  required: true,
  schema: { type: 'string', format: 'uuid' }
};

const sessionIdParameter = {
  in: 'path',
  name: 'sessionId',
  required: true,
  schema: { type: 'string', example: 'workflow-session-01' }
};

const workflowWorkspaceIdQueryParameter = {
  in: 'query',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const externalUserHeader = {
  in: 'header',
  name: 'x-acornops-external-user-id',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Required only for external integration client-token requests. Must identify a linked external integration user.'
};

const workspaceBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
        },
        additionalProperties: false
      }
    }
  }
};

const workflowAuthoringProperties = {
  name: { type: 'string' },
  description: { type: 'string' },
  status: { type: 'string', enum: ['active', 'draft', 'paused'] },
  prompt: { type: 'string' },
  agentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  tags: { type: 'array', items: { type: 'string' } }
};

const workflowMutationBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId', 'agentIds'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          ...workflowAuthoringProperties
        },
        additionalProperties: false
      }
    }
  }
};

const workflowCreateBody = {
  ...workflowMutationBody,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['name', 'prompt', 'agentIds'],
        properties: workflowAuthoringProperties,
        additionalProperties: false
      }
    }
  }
};

const workflowCapabilitiesPreviewBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workspaceId', 'approvedContextGrants'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID },
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    }
  }
};

const workflowScheduleBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['workflowId', 'name', 'cron', 'timezone', 'principal'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          workflowId: { type: 'string' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron: { type: 'string', example: '0 9 * * 1-5' },
          timezone: { type: 'string', example: 'UTC' },
          approvedContextGrants: { type: 'array', items: { type: 'string' } },
          principal: { type: 'object', required: ['type', 'id'], properties: {
            type: { type: 'string', enum: ['user'] }, id: { type: 'string' }
          }, additionalProperties: false }
        },
        additionalProperties: true
      }
    }
  }
};

export function buildWorkflowPaths(): Record<string, unknown> {
  return {
    ...buildWorkflowWebhookPaths(),
    '/api/v1/workspaces/{workspaceId}/workflows': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow definitions for a workspace',
        description: 'Returns workspace-owned workflow definitions visible to management-console. Workflows created from workspace defaults or recommendations are ordinary editable definitions. Requires read_workspace_data.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow definitions for the workspace.' } }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workspace workflow definition',
        description: 'Creates a Workflow definition from one or more active reviewed specialist Agent IDs. One Agent produces a specialist root run; multiple Agents produce a coordinator root with delegated specialist children. Selection order has no meaning and executionMode is derived. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowCreateBody,
        responses: { '201': { description: 'Workflow definition created.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/workflow-options': {
      get: {
        tags: ['workflows'],
        summary: 'List server-compiled workflow options',
        description: 'Returns the active and inactive specialist Agents available for Workflow assignment. Tools, MCP servers, skills, context, permissions, and approval behavior are owned by Agents and are not authorable Workflow options.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: { '200': { description: 'Workflow option catalog.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/workflow-schedules': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow schedules for a workspace',
        description: 'Returns control-plane-owned workflow schedules and summary metrics. Requires read_workspace_data.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: { '200': { description: 'Workflow schedule list and summary.' } }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create workflow schedule',
        description: 'Creates a scheduled workflow automation. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowScheduleBody,
        responses: { '201': { description: 'Workflow schedule created.' } }
      }
    },
    '/api/v1/workflow-schedules/{scheduleId}': {
      patch: {
        tags: ['workflows'],
        summary: 'Update workflow schedule',
        description: 'Updates schedule cadence, enabled state, workflow, or grants. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [scheduleIdParameter],
        requestBody: workflowScheduleBody,
        responses: { '200': { description: 'Workflow schedule updated.' } }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete workflow schedule',
        security: [{ userSession: [] }],
        parameters: [scheduleIdParameter],
        responses: { '204': { description: 'Workflow schedule deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/workflow-schedules/preview': {
      post: {
        tags: ['workflows'],
        summary: 'Preview a workflow schedule',
        description: 'Compiles the active saved workflow definition and validates context grants, cron, and timezone without creating or changing a schedule.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowScheduleBody,
        responses: { '200': { description: 'Schedule validation, readable summary, and upcoming run times.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/approvals': {
      get: {
        tags: ['workflows'],
        summary: 'List workspace approval inbox',
        description: 'Normalizes interactive tool approvals and workflow approval gates into a single workspace inbox. pendingCount is the total pending count across both sources before pagination and is independent of the requested status filter. Decisions remain on the run-scoped approval decision endpoint.',
        security: [{ userSession: [] }],
        parameters: [
          workspaceIdParameter,
          { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['pending', 'decided', 'all'], default: 'pending' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'runId', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Optional exact run filter for approval deep links.' },
          { in: 'query', name: 'approvalId', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Optional exact approval filter for approval deep links.' }
        ],
        responses: { '200': { description: 'Unified approval inbox page.' } }
      }
    },
    '/api/v1/workflows/{workflowId}': {
      get: {
        tags: ['workflows'],
        summary: 'Get a workflow definition',
        description: 'External integration callers can fetch only active workflows permitted by the linked user role, user-approved workspace grant, and client capability ceiling. Read-write or approval-gated workflows require create_read_write_runs.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workflowIdParameter, workflowWorkspaceIdQueryParameter],
        responses: { '200': { description: 'Workflow definition detail.' } }
      },
      patch: {
        tags: ['workflows'],
        summary: 'Update a workflow definition',
        description: 'Workspace workflows accept definition edits from users with manage_workflows, including workflows created from workspace defaults or recommendations.',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workflowMutationBody,
        responses: {
          '200': { description: 'Workflow definition updated.' },
          '403': { description: 'Requires manage_workflows.' }
        }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete a workflow definition',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workspaceBody,
        responses: {
          '204': { description: 'Workflow definition deleted.' },
        }
      }
    },
    '/api/v1/workflows/{workflowId}/duplicate': {
      post: {
        tags: ['workflows'],
        summary: 'Duplicate a workflow as a custom draft',
        description: 'Copies the effective definition only. Runs, sessions, schedules, workflow webhooks, and activity are not copied.',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspaceId'],
                properties: {
                  workspaceId: { type: 'string', format: 'uuid' },
                  name: { type: 'string' }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          '201': { description: 'Custom draft created and owned by the current user.' },
          '403': { description: 'Requires manage_workflows.' }
        }
      }
    },
    '/api/v1/workflows/{workflowId}/capabilities-preview': {
      post: {
        tags: ['workflows'],
        summary: 'Preview the effective workflow capability scope',
        description: 'Compiles a non-reserving, secret-free snapshot of semantic capabilities, exact effective tools, direct MCP attachments, skills, and approval requirements. Requires read_workspace_data and the same run-creation capability as launch. Dispatch always recompiles and remains authoritative.',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workflowCapabilitiesPreviewBody,
        responses: {
          '200': {
            description: 'Workflow capability compatibility and effective access preview.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowCapabilitiesPreview' } } }
          },
          '403': { description: 'The current workspace role cannot read workspace data or create this run mode.' }
        }
      }
    },
    '/api/v1/workflows/{workflowId}/sessions': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow sessions',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter, workflowWorkspaceIdQueryParameter],
        responses: { '200': { description: 'Workflow sessions and run history.' } }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workflow session',
        description: 'External integration callers can create sessions only for active workflows permitted by the linked user role, user-approved workspace grant, and client capability ceiling. Read-write or approval-gated workflows require create_read_write_runs; other workflows require create_read_only_runs.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workflowIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspaceId'],
                properties: {
                  workspaceId: { type: 'string', format: 'uuid' },
                  approvedContextGrants: { type: 'array', items: { type: 'string' } }
                },
                additionalProperties: true
              }
            }
          }
        },
        responses: { '201': { description: 'Workflow session created.' } }
      }
    },
    '/api/v1/workflow-sessions/{sessionId}/messages': {
      post: {
        tags: ['workflows'],
        summary: 'Post a workflow session message and dispatch a run',
        description: 'A session accepts one parameterless launch followed by ordinary follow-up messages. Idempotent launch retries return the original execution.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, sessionIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['kind'],
                    properties: {
                      kind: { type: 'string', enum: ['launch'] },
                      clientRequestId: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                        description: 'Optional non-empty idempotency key supplied by the client.'
                      }
                    },
                    additionalProperties: false
                  },
                  {
                    type: 'object',
                    required: ['kind', 'content'],
                    properties: {
                      kind: { type: 'string', enum: ['follow_up'] },
                      content: { type: 'string', minLength: 1, maxLength: 32768 },
                      clientRequestId: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                        description: 'Optional non-empty idempotency key supplied by the client.'
                      }
                    },
                    additionalProperties: false
                  }
                ]
              }
            }
          }
        },
        responses: {
          '202': { description: 'Workflow run accepted.', headers: { 'X-Example-Run-Id': { schema: { type: 'string', example: EXAMPLE_RUN_ID } } } },
          '409': {
            description: 'Workflow or exact MCP readiness is unavailable. MCP conflicts include bounded structured installation and tool failures.',
            content: { 'application/json': { schema: {
              oneOf: [
                { $ref: '#/components/schemas/ErrorResponse' },
                { $ref: '#/components/schemas/McpReadinessErrorResponse' }
              ]
            } } }
          }
        }
      }
    },
    '/api/v1/workflow-executions/{executionId}': {
      get: {
        tags: ['workflows'], summary: 'Get workflow execution, attempts, and sanitized coordination', security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, { in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow execution with retained attempts and, for normal users, immutable origin provenance. Coordinated runs include a sanitized child summary without prompts, compiled scopes, results, credentials, or coordinator identity.', content: { 'application/json': { schema: { type: 'object', required: ['execution', 'attempts'], properties: { execution: { type: 'object', properties: { origin: { $ref: '#/components/schemas/WorkflowExecutionOrigin' } }, additionalProperties: true }, attempts: { type: 'array', items: { type: 'object' } }, coordination: { $ref: '#/components/schemas/WorkflowCoordinationSummary' } } } } } } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/workflow-executions': {
      get: {
        tags: ['workflows'], summary: 'List workspace workflow executions with immutable provenance',
        security: [{ userSession: [] }],
        parameters: [
          workspaceIdParameter,
          { in: 'query', name: 'state', required: false, schema: { type: 'string', enum: ['all', 'open', 'attention', 'completed', 'failed', 'cancelled'] } },
          { in: 'query', name: 'origin', required: false, schema: { type: 'string', enum: ['manual', 'external_integration', 'schedule', 'webhook'] } },
          { in: 'query', name: 'workflowId', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'search', required: false, schema: { type: 'string', maxLength: 200 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } }
        ],
        responses: {
          '200': {
            description: 'Cursor-paginated execution ledger and current workspace counts.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecutionPage' } } }
          }
        }
      }
    },
    '/api/v1/workflow-executions/{executionId}/stream': {
      get: {
        tags: ['workflows'],
        summary: 'Replay and stream sanitized workflow execution events',
        description: 'Workspace-authorized browser and external integration callers may replay durable aggregate execution events and continue over SSE. Prompts, compiled scopes, credentials, integration provenance, and tool arguments are not included.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [
          externalUserHeader,
          { in: 'path', name: 'executionId', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'after', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Last durable event id already observed.' }
        ],
        responses: { '200': { description: 'Server-sent workflow_execution events, preceded by durable replay after the supplied cursor.', content: streamContent() } }
      }
    },
    '/api/v1/workflow-executions/{executionId}/cancel': {
      post: {
        tags: ['workflows'], summary: 'Cancel a workflow execution', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Cancellation accepted.', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } } }
      }
    },
    '/api/v1/workflow-executions/{executionId}/resume': {
      post: {
        tags: ['workflows'], summary: 'Resume a failed Workflow root as a new attempt', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Resume attempt and dispatch intent committed.', content: { 'application/json': { schema: { type: 'object', properties: { executionId: { type: 'string' }, runId: { type: 'string' }, status: { type: 'string' } } } } } }, '409': { description: 'Execution is not resumable.' } }
      }
    },
    '/api/v1/report-artifacts/{reportId}': {
      get: {
        tags: ['runs', 'workflows'], summary: 'Get generated document metadata', security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, { in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Document metadata without source or artifact bytes.' } }
      }
    },
    '/api/v1/report-artifacts/{reportId}/download': {
      get: {
        tags: ['runs', 'workflows'], summary: 'Render and stream a generated document', security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, { in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'PDF or Markdown document stream.', content: {
          'application/pdf': { schema: { type: 'string', format: 'binary' } },
          'text/markdown': { schema: { type: 'string' } }
        } } }
      }
    }
  };
}
