import { EXAMPLE_RUN_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';
import { streamContent } from './schema-types.js';

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
  resourceRequirements: { type: 'array', items: { $ref: '#/components/schemas/PromptResourceRequirement' } },
  capabilityPolicy: { type: 'object', properties: {
    mode: { type: 'string', enum: ['read_only', 'read_write'] },
    restrictionMode: { type: 'string', enum: ['inherit', 'restrict'] },
    semanticCapabilityIds: { type: 'array', items: { type: 'string' } },
    contextGrants: { type: 'array', items: { type: 'string' } },
    approvalRequirements: { type: 'array', items: { type: 'string' } }
  }, additionalProperties: false },
  tags: { type: 'array', items: { type: 'string' } },
  requiredPermissions: { type: 'array', items: { type: 'string' } }
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
        required: ['workspaceId', 'approvedContextGrants', 'inputs'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID },
          approvedContextGrants: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Exact runtime parameter values compiled using the same path as launch.' }
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
        required: ['workflowId', 'name', 'cron', 'timezone', 'inputs', 'principal'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          workflowId: { type: 'string' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron: { type: 'string', example: '0 9 * * 1-5' },
          timezone: { type: 'string', example: 'UTC' },
          inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Exact workflow runtime parameter values re-resolved and reauthorized for every occurrence.' },
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
    '/api/v1/workspaces/{workspaceId}/workflows': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow definitions for a workspace',
        description: 'Returns system-provided template-origin and manually created workflow definitions visible to management-console. Requires read_workspace_data.',
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
        description: 'Creates a Workflow V2 definition from one or more active reviewed specialist Agent IDs. One Agent produces a specialist root run; multiple Agents produce a coordinator root with delegated specialist children. Selection order has no meaning and executionMode is derived. Requires manage_workflows.',
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
        description: 'Returns workflow options. Runtime and retention policy lists contain the single effective deployment-wide value. When agentId is supplied, MCP servers, exact tool references, and skills are limited to that Agent’s installed capability ceiling. The endpoint never exposes catalog installation actions.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, { in: 'query', name: 'agentId', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow option catalog.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/prompt-reference-types': {
      get: {
        tags: ['prompt resources'], summary: 'List prompt reference providers',
        description: 'Returns registry descriptors, including unavailable providers and bounded reasons. Implicit providers are not author-selectable.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter], responses: { '200': { description: 'Registered prompt reference descriptors.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/prompt-references/suggestions': {
      get: {
        tags: ['prompt resources'], summary: 'Suggest prompt resource candidates',
        description: 'Returns same-workspace candidates from one registered provider. Candidate IDs are preview data, never launch authority.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter,
          { in: 'query', name: 'type', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'workflowId', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } }],
        responses: { '200': { description: 'Prompt resource candidates.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/prompt-references/resolve': {
      post: {
        tags: ['prompt resources'], summary: 'Preview prompt resource resolution',
        description: 'Authoring-only preview that parses concrete @type[label] references and returns derived runtime parameters. Run creation always resolves and authorizes again.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', maxLength: 32768 }, workflowId: { type: 'string' }, requirements: { type: 'array', items: { $ref: '#/components/schemas/PromptResourceRequirement' } } }, additionalProperties: false } } } },
        responses: { '200': { description: 'Parsed concrete references, derived parameters, candidate status, binding preview, and blockers.' } }
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
        description: 'Updates schedule cadence, enabled state, workflow, grants, or runtime inputs. Requires manage_workflows.',
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
        description: 'Compiles the active workflow with the submitted inputs and validates context grants, cron, and timezone without creating or changing a schedule.',
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
        description: 'Normalizes target write-tool approvals and workflow approval gates into a single workspace inbox. pendingCount is the total pending count across both sources before pagination and is independent of the requested status filter. Decisions remain on the run-scoped approval decision endpoint.',
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
        description: 'Manual workflows accept definition edits. System-provided workflows accept availability-status changes only; duplicate one to edit its definition.',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workflowMutationBody,
        responses: {
          '200': { description: 'Workflow definition updated.' },
          '403': { description: 'Requires manage_workflows.' },
          '409': { description: 'System-provided workflow definition is immutable; duplicate it to edit.' }
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
        description: 'Copies the effective definition only. Runs, sessions, schedules, triggers, activity, and version history are not copied.',
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
        description: 'Compiles a non-reserving, secret-free snapshot of semantic capabilities, eligible targets, exact effective tools, direct MCP attachments, skills, and approval requirements. The stored target type is authoritative. Requires read_workspace_data and the same run-creation capability as launch. Dispatch always recompiles and remains authoritative.',
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
        description: 'A session accepts one launch followed by ordinary follow-up messages. Idempotent launch retries return the original execution. Resource parameters are reauthorized by stable ID on every follow-up.',
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
                    required: ['kind', 'inputs'],
                    properties: {
                      kind: { type: 'string', enum: ['launch'] },
                      inputs: { type: 'object', additionalProperties: { type: 'string' } },
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
            description: 'Workflow version, target, or exact MCP readiness is unavailable. MCP conflicts include bounded structured installation and tool failures.',
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
        responses: { '200': { description: 'Workflow execution with retained attempts and, for coordinated runs, a sanitized child summary without prompts, compiled scopes, results, credentials, or coordinator identity.', content: { 'application/json': { schema: { type: 'object', required: ['execution', 'attempts'], properties: { execution: { type: 'object' }, attempts: { type: 'array', items: { type: 'object' } }, coordination: { $ref: '#/components/schemas/WorkflowCoordinationSummary' } } } } } } }
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
        tags: ['runs', 'workflows'], summary: 'Get report artifact metadata', security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, { in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Report metadata without report source or PDF bytes.' } }
      }
    },
    '/api/v1/report-artifacts/{reportId}/download': {
      get: {
        tags: ['runs', 'workflows'], summary: 'Render and stream a report artifact', security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, { in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Freshly rendered PDF stream.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } }
      }
    }
  };
}
