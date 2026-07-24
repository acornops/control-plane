import { EXAMPLE_WORKSPACE_ID } from '../../constants/dev-defaults.js';

const workspaceIdParameter = {
  in: 'path',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const agentIdPathParameter = {
  in: 'path',
  name: 'agentId',
  required: true,
  schema: { type: 'string', example: 'agt_01JEXAMPLE' }
};

const nativeToolIdPathParameter = {
  in: 'path', name: 'toolId', required: true,
  schema: { type: 'string', example: 'reports.pdf.generate' }
};

const agentWorkspaceIdQueryParameter = {
  in: 'query',
  name: 'workspaceId',
  required: true,
  schema: { type: 'string', format: 'uuid', example: EXAMPLE_WORKSPACE_ID }
};

const agentWorkspaceBody = {
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

export function buildAgentPaths(): Record<string, unknown> {
  return {
    '/api/v1/workspaces/{workspaceId}/catalog/native-tools': {
      get: {
        tags: ['agents'], summary: 'List AcornOps workspace-native tools',
        description: 'Returns the code-owned native-tool catalog. Requires workspace read access.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter],
        responses: { '200': { description: 'Native tool catalog with schemas, invocation scope, authorization class, and audit operation.', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceNativeToolList' } } } } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/native-tools/{toolId}': {
      put: {
        tags: ['agents'], summary: 'Grant a workspace-native tool to a specialist Agent',
        description: 'Transactionally updates the Agent version, reviewed routing mappings, semantic ceiling, and dependent readiness. Requires manage_agents; manage_mcp is not required.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter, agentIdPathParameter, nativeToolIdPathParameter],
        responses: { '200': { description: 'Updated Agent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentResponse' } } } }, '403': { description: 'Requires manage_agents.' }, '404': { description: 'Agent or tool not found.' } }
      },
      delete: {
        tags: ['agents'], summary: 'Revoke a workspace-native tool from a specialist Agent',
        description: 'Disables reviewed mappings that depend on the tool and recomputes dependent readiness.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter, agentIdPathParameter, nativeToolIdPathParameter],
        responses: { '200': { description: 'Updated Agent.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentResponse' } } } }, '403': { description: 'Requires manage_agents.' }, '404': { description: 'Agent or tool not found.' } }
      }
    },
    '/api/v1/workspaces/{workspaceId}/automation-templates': {
      get: { tags: ['agents'], summary: 'List automation templates and setup state', description: 'Returns automatic and opt-in templates, setup steps, accepted integration profiles, blocker codes, and installation state. Automatic templates are provisioned with the workspace; opt-in definitions are absent until installed.', security: [{ userSession: [] }], parameters: [workspaceIdParameter], responses: { '200': { description: 'Template catalog and installation rows.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/automation-templates/{templateId}/install': {
      post: { tags: ['agents'], summary: 'Install or explicitly reinstall an automation template', description: 'Idempotently creates paused definitions for opt-in templates. Requires manage_agents and manage_workflows.', security: [{ userSession: [] }], parameters: [workspaceIdParameter, { in: 'path', name: 'templateId', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Template was already installed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateInstallResult' } } } }, '201': { description: 'Template installed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateInstallResult' } } } }, '403': { description: 'Missing management permissions.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/automation-templates/{templateId}/activate': {
      post: { tags: ['agents'], summary: 'Activate an installed automation template', description: 'Activation succeeds only when reviewed workspace prerequisites are ready.', security: [{ userSession: [] }], parameters: [workspaceIdParameter, { in: 'path', name: 'templateId', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Template activated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateActivationResult' } } } }, '409': { description: 'Workspace prerequisites are incomplete.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/agents': {
      get: {
        tags: ['agents'],
        summary: 'List active workspace agents',
        description: 'Returns reusable specialist capability profiles available in the workspace.',
        security: [{ userSession: [] }],
        parameters: [
          workspaceIdParameter,
          { in: 'query', name: 'includeInactive', required: false, schema: { type: 'boolean' } },
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Agent list for the workspace.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      },
      post: {
        tags: ['agents'],
        summary: 'Create a custom specialist Agent',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentMutation' }
            }
          }
        },
        responses: {
          '201': { description: 'Agent created.' },
          '403': { description: 'Requires manage_agents.' }
        }
      }
    },
    '/api/v1/agents/{agentId}': {
      get: {
        tags: ['agents'],
        summary: 'Get an agent definition',
        description: 'Returns a reusable specialist capability profile by ID.',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Agent detail.' }, '404': { description: 'Agent not found or is system-owned coordination infrastructure.' } }
      },
      patch: {
        tags: ['agents'],
        summary: 'Update an agent definition',
        description: 'Manual Agents accept definition edits. System-provided Agents accept availability-status changes only; duplicate one to edit its definition. MCP servers and skills are managed through the nested Agent capability APIs.',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentMutation' }
            }
          }
        },
        responses: {
          '200': { description: 'Agent updated.' },
          '403': { description: 'Requires manage_agents.' },
          '409': { description: 'System-provided Agent definitions are immutable, or the requested change conflicts with an active assignment or policy.' }
        }
      },
      delete: {
        tags: ['agents'],
        summary: 'Delete an unassigned agent definition',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        responses: {
          '204': { description: 'Agent deleted.' },
          '403': { description: 'Requires manage_agents.' },
          '409': { description: 'The Agent is still assigned to one or more dependent workflows.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/duplicate': {
      post: {
        tags: ['agents'],
        summary: 'Duplicate an agent as a manual draft',
        description: 'Copies the effective definition only. Runs, triggers, activity, schedules, version history, and origin attribution are not copied.',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentDuplicateMutation' }
            }
          }
        },
        responses: {
          '201': { description: 'Custom draft created and owned by the current user.' },
          '403': { description: 'Requires manage_agents.' },
          '409': { description: 'The definition cannot be duplicated while its referenced capabilities are unavailable.' }
        }
      }
    },
    '/api/v1/workspaces/{workspaceId}/automation/diagnostics': {
      get: {
        tags: ['agents'],
        summary: 'Inspect workspace automation readiness and durable runtime health',
        description: 'Reports automation-specific dependencies and backlogs without affecting the process-level /ready probe.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter],
        responses: {
          '200': { description: 'Sanitized runtime mode, queue, run, trigger, approval, template readiness, and report-source diagnostics.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/versions': {
      get: {
        tags: ['agents'],
        summary: 'List saved agent version snapshots',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter, agentWorkspaceIdQueryParameter,
          { in: 'query', name: 'q', required: false, schema: { type: 'string' } },
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { in: 'query', name: 'cursor', required: false, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Agent version snapshots.' },
          '403': { description: 'Requires read_workspace_data.' }
        }
      },
      post: {
        tags: ['agents'],
        summary: 'Snapshot the current agent version',
        security: [{ userSession: [] }],
        parameters: [agentIdPathParameter],
        requestBody: agentWorkspaceBody,
        responses: {
          '201': { description: 'Agent version snapshot created.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/versions/{versionId}/restore': {
      post: {
        tags: ['agents'],
        summary: 'Restore a saved agent version snapshot',
        security: [{ userSession: [] }],
        parameters: [
          agentIdPathParameter,
          { in: 'path', name: 'versionId', required: true, schema: { type: 'string' } }
        ],
        requestBody: agentWorkspaceBody,
        responses: {
          '200': { description: 'Agent restored from snapshot as a new current version.' },
          '403': { description: 'Requires manage_agents.' }
        }
      }
    },
  };
}
