import { EXAMPLE_RUN_ID, EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

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
        additionalProperties: true
      }
    }
  }
};

const workflowMutationBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['agentIds'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['active', 'draft', 'paused'] },
          prompt: { type: 'string' },
          agentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
          targetConstraints: { type: 'object', properties: {
            targetTypes: { type: 'array', items: { type: 'string', enum: ['kubernetes', 'virtual_machine'] } },
            targetIds: { type: 'array', items: { type: 'string' } }
          }, additionalProperties: false },
          capabilityPolicy: { type: 'object', properties: {
            mode: { type: 'string', enum: ['read_only', 'read_write'] },
            restrictionMode: { type: 'string', enum: ['inherit', 'restrict'] },
            semanticCapabilityIds: { type: 'array', items: { type: 'string' } },
            contextGrants: { type: 'array', items: { type: 'string' } },
            maxRuntimeSeconds: {
              type: 'integer',
              minimum: 1,
              deprecated: true,
              description: 'Compatibility field accepted but ignored. The deployment-wide ASSISTANT_MAX_RUNTIME_MS setting is authoritative.'
            },
            retentionDays: {
              type: 'integer',
              minimum: 1,
              deprecated: true,
              description: 'Compatibility field accepted but ignored. The deployment-wide report retention setting is authoritative.'
            },
            approvalRequirements: { type: 'array', items: { type: 'string' } }
          }, additionalProperties: false },
          tags: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          requiredPermissions: { type: 'array', items: { type: 'string' } }
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
        ...workflowMutationBody.content['application/json'].schema,
        required: ['name', 'prompt', 'agentIds']
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
          approvedContextGrants: { type: 'array', items: { type: 'string' } },
          target: {
            type: 'object',
            required: ['id', 'targetType'],
            properties: {
              id: { type: 'string' },
              targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] }
            },
            additionalProperties: false
          }
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
          inputDefaults: { type: 'object', additionalProperties: true },
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
        description: 'Creates a Workflow V2 definition from one or more active reviewed specialist Agent IDs. One Agent runs directly; multiple Agents are coordinated by AcornOps. Selection order has no meaning and executionMode is derived. Requires manage_workflows.',
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
        description: 'Updates schedule cadence, enabled state, workflow, grants, or defaults. Requires manage_workflows.',
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
        description: 'Validates workflow inputs, context grants, cron, and timezone without creating or changing a schedule.',
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
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
        ],
        responses: { '200': { description: 'Unified approval inbox page.' } }
      }
    },
    '/api/v1/workflows/{workflowId}': {
      get: {
        tags: ['workflows'],
        summary: 'Get a workflow definition',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter, workflowWorkspaceIdQueryParameter],
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
        security: [{ userSession: [] }],
        parameters: [sessionIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: {
                    type: 'string',
                    description: 'Control message. Target-bound launches use one exact @target[Development Cluster] reference. Legacy @cluster[Development Cluster] references remain accepted.'
                  },
                  inputs: {
                    type: 'object',
                    description: 'Structured authorization bindings derived from prompt references. Incident reports bind mentioned chats as chatSessionIds.',
                    additionalProperties: true
                  },
                  clientRequestId: { type: 'string', description: 'Optional idempotency key supplied by the client.' },
                  targetId: { type: 'string', description: 'Exact target identifier derived from the target reference in the control message.' },
                  targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] }
                },
                additionalProperties: true
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
        tags: ['workflows'], summary: 'Get workflow execution, attempts, and sanitized coordination', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow execution with retained attempts and, for coordinated runs, a sanitized child summary without prompts, compiled scopes, results, credentials, or coordinator identity.', content: { 'application/json': { schema: { type: 'object', required: ['execution', 'attempts'], properties: { execution: { type: 'object' }, attempts: { type: 'array', items: { type: 'object' } }, coordination: { $ref: '#/components/schemas/WorkflowCoordinationSummary' } } } } } } }
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
        tags: ['workflows'], summary: 'Resume a failed workflow entry run as a new attempt', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Resume attempt and dispatch intent committed.', content: { 'application/json': { schema: { type: 'object', properties: { executionId: { type: 'string' }, runId: { type: 'string' }, status: { type: 'string' } } } } } }, '409': { description: 'Execution is not resumable.' } }
      }
    },
    '/api/v1/workflow-reports/{reportId}': {
      get: {
        tags: ['workflows'], summary: 'Get PDF report artifact metadata', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Report metadata without report source or PDF bytes.', content: { 'application/json': { schema: { type: 'object', properties: { report: { type: 'object' } } } } } } }
      }
    },
    '/api/v1/workflow-reports/{reportId}/download': {
      get: {
        tags: ['workflows'], summary: 'Render and stream a PDF report', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Freshly rendered PDF stream.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } }
      }
    },
    '/api/v1/report-artifacts/{reportId}': {
      get: {
        tags: ['runs', 'workflows'], summary: 'Get report artifact metadata', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Report metadata without report source or PDF bytes.' } }
      }
    },
    '/api/v1/report-artifacts/{reportId}/download': {
      get: {
        tags: ['runs', 'workflows'], summary: 'Render and stream a report artifact', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'reportId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Freshly rendered PDF stream.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } }
      }
    }
  };
}
