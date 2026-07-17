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

const serverIdParameter = {
  in: 'path',
  name: 'serverId',
  required: true,
  schema: { type: 'string', example: 'workflow-mcp-prometheus' }
};

const toolNameParameter = {
  in: 'path',
  name: 'toolName',
  required: true,
  schema: { type: 'string', example: 'issues.list' }
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
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['active', 'draft', 'paused'] },
          category: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          enabledMcpServers: { type: 'array', items: { type: 'string' } },
          enabledSkills: { type: 'array', items: { type: 'string' } },
          requiredPermissions: { type: 'array', items: { type: 'string' } },
          policy: { type: 'object', additionalProperties: true },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          starterPrompt: { type: 'string' }
        },
        additionalProperties: true
      }
    }
  }
};

const workflowMcpServerBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          enabled: { type: 'boolean' },
          auth: { type: 'object', additionalProperties: true },
          publicHeaders: { type: 'object', additionalProperties: { type: 'string' } }
        },
        additionalProperties: true
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
        required: ['workflowId', 'name', 'cron', 'timezone'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
          workflowId: { type: 'string' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron: { type: 'string', example: '0 9 * * 1-5' },
          timezone: { type: 'string', example: 'UTC' },
          inputDefaults: { type: 'object', additionalProperties: true },
          approvedContextGrants: { type: 'array', items: { type: 'string' } }
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
        description: 'Returns system and user workflow definitions visible to management-console. External integration callers receive only active read-only workflows without approval gates that their linked user grant can run.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workspaceIdParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow definitions for the workspace.' } }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workspace workflow definition',
        description: 'Creates a user workflow definition from server-owned workflow options. Requires manage_workflows.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowMutationBody,
        responses: { '201': { description: 'Workflow definition created.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/workflow-options': {
      get: {
        tags: ['workflows'],
        summary: 'List server-compiled workflow options',
        description: 'Returns selectable agents, MCP servers, tools, skills, approval policies, runtime limits, and retention policies for workflow builders.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: { '200': { description: 'Workflow option catalog.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/mcp/servers': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow-scoped MCP servers',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: { '200': { description: 'Workflow MCP servers for the workspace.' } }
      },
      post: {
        tags: ['workflows'],
        summary: 'Create a workflow-scoped MCP server',
        description: 'Creates an MCP server available to workflow definitions. Requires manage_mcp.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: workflowMcpServerBody,
        responses: { '201': { description: 'Workflow MCP server created.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/mcp/servers/{serverId}': {
      patch: {
        tags: ['workflows'],
        summary: 'Update a workflow-scoped MCP server',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, serverIdParameter],
        requestBody: workflowMcpServerBody,
        responses: { '200': { description: 'Workflow MCP server updated.' } }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete a workflow-scoped MCP server',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, serverIdParameter],
        responses: { '204': { description: 'Workflow MCP server deleted.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/mcp/servers/{serverId}/test-connection': {
      post: {
        tags: ['workflows'],
        summary: 'Test workflow MCP server connection',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, serverIdParameter],
        responses: { '200': { description: 'Workflow MCP server connection check result.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/mcp/servers/{serverId}/tools': {
      get: {
        tags: ['workflows'],
        summary: 'List workflow MCP server tools',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, serverIdParameter],
        responses: { '200': { description: 'Workflow MCP server tools.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/mcp/servers/{serverId}/tools/{toolName}': {
      patch: {
        tags: ['workflows'],
        summary: 'Review and enable or disable a workspace MCP tool',
        description: 'Requires manage_mcp. Enabling a newly discovered tool requires an explicit read or write capability.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, serverIdParameter, toolNameParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['enabled', 'capability'],
                properties: {
                  enabled: { type: 'boolean' },
                  capability: { type: 'string', enum: ['read', 'write'] }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: { '200': { description: 'Workspace MCP tool updated.' } }
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
        description: 'External integration callers can fetch only active read-only workflows without approval gates that their linked user grant can run.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, workflowIdParameter, workflowWorkspaceIdQueryParameter],
        responses: { '200': { description: 'Workflow definition detail.' } }
      },
      patch: {
        tags: ['workflows'],
        summary: 'Update a workflow definition',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workflowMutationBody,
        responses: { '200': { description: 'Workflow definition updated.' } }
      },
      delete: {
        tags: ['workflows'],
        summary: 'Delete a user workflow definition',
        security: [{ userSession: [] }],
        parameters: [workflowIdParameter],
        requestBody: workspaceBody,
        responses: { '204': { description: 'Workflow definition deleted.' } }
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
        description: 'External integration callers can create sessions only for active read-only workflows without approval gates when read_workspace_data, create_sessions, and create_read_only_runs are granted.',
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
        description: 'External integration callers can dispatch runs only for externally runnable read-only workflow sessions.',
        security: [{ userSession: [] }, { externalIntegrationClientToken: [] }],
        parameters: [externalUserHeader, sessionIdParameter],
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
                    description: 'Control message. Target-bound launches use exact prompt references such as @cluster[Development Cluster] or @chat[Payments incident].'
                  },
                  inputs: {
                    type: 'object',
                    description: 'Structured authorization bindings derived from prompt references. Incident reports bind mentioned chats as chatSessionIds.',
                    additionalProperties: true
                  },
                  clientRequestId: { type: 'string', description: 'Optional idempotency key supplied by the client.' },
                  targetId: { type: 'string', description: 'Exact target identifier bound from the cluster reference in the control message.' },
                  targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] }
                },
                additionalProperties: true
              }
            }
          }
        },
        responses: { '202': { description: 'Workflow run accepted.', headers: { 'X-Example-Run-Id': { schema: { type: 'string', example: EXAMPLE_RUN_ID } } } } }
      }
    },
    '/api/v1/workflow-executions/{executionId}': {
      get: {
        tags: ['workflows'], summary: 'Get workflow execution and step attempts', security: [{ userSession: [] }],
        parameters: [{ in: 'path', name: 'executionId', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Workflow execution with retained attempts.', content: { 'application/json': { schema: { type: 'object', properties: { execution: { type: 'object' }, attempts: { type: 'array', items: { type: 'object' } } } } } } } }
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
        tags: ['workflows'], summary: 'Resume a failed workflow step as a new attempt', security: [{ userSession: [] }],
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
    }
  };
}
