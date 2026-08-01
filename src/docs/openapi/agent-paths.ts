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

const agentConversationIdPathParameter = {
  in: 'path',
  name: 'conversationId',
  required: true,
  schema: { type: 'string', format: 'uuid' }
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
        description: 'Transactionally grants or updates a workspace-native tool, its optional validated configuration, reviewed routing mappings, semantic ceiling, and dependent readiness. Requires manage_agents; manage_mcp is not required.',
        security: [{ userSession: [] }], parameters: [workspaceIdParameter, agentIdPathParameter, nativeToolIdPathParameter],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { config: { type: 'object', additionalProperties: true } },
                additionalProperties: false
              }
            }
          }
        },
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
      get: { tags: ['agents'], summary: 'List recommended workflows and setup state', description: 'Returns the workflows AcornOps recommends as starting points, along with setup steps, accepted integration profiles, blocker codes, and addition state. Default workflows are created once with the workspace; optional recommendations are absent until explicitly added. Resulting workflows are workspace-owned and directly editable.', security: [{ userSession: [] }], parameters: [workspaceIdParameter], responses: { '200': { description: 'Recommended workflow catalog and addition state.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/automation-templates/{templateId}/install': {
      post: { tags: ['agents'], summary: 'Add a recommended workflow', description: 'Idempotently creates a paused, workspace-owned workflow from an optional recommendation. AcornOps does not maintain or overwrite the resulting definition. Requires manage_agents and manage_workflows.', security: [{ userSession: [] }], parameters: [workspaceIdParameter, { in: 'path', name: 'templateId', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The recommended workflow was already added.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateInstallResult' } } } }, '201': { description: 'Recommended workflow added.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateInstallResult' } } } }, '403': { description: 'Missing management permissions.' } } }
    },
    '/api/v1/workspaces/{workspaceId}/automation-templates/{templateId}/activate': {
      post: { tags: ['agents'], summary: 'Activate an added recommended workflow', description: 'Activation succeeds only when reviewed workspace prerequisites are ready.', security: [{ userSession: [] }], parameters: [workspaceIdParameter, { in: 'path', name: 'templateId', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Recommended workflow activated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AutomationTemplateActivationResult' } } } }, '409': { description: 'Workspace prerequisites are incomplete.' } } }
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
    '/api/v1/workspaces/{workspaceId}/agents/{agentId}/conversations': {
      get: {
        tags: ['agents'],
        summary: 'List Agent conversations',
        description: 'Workspace-readable manual conversations for one Agent, backed by the interactive conversation runtime.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, agentIdPathParameter],
        responses: {
          '200': { description: 'Agent conversation summaries.' },
          '403': { description: 'Requires workspace read access.' },
          '404': { description: 'Agent not found.' }
        }
      },
      post: {
        tags: ['agents'],
        summary: 'Create an Agent conversation',
        description: 'Creates a single-Agent interactive conversation. Access defaults to the intersection of the current Agent policy and the creator run permissions; each message resolves the current Agent and pins the effective definition and scope on its run.',
        security: [{ userSession: [] }],
        parameters: [workspaceIdParameter, agentIdPathParameter],
        responses: {
          '201': { description: 'Agent conversation created with policy-derived access.' },
          '403': { description: 'Requires create_sessions and a run capability compatible with the pinned Agent policy.' },
          '409': { description: 'Agent is not ready for chat.' }
        }
      }
    },
    '/api/v1/agent-conversations/{conversationId}': {
      get: {
        tags: ['agents'],
        summary: 'Read an Agent conversation',
        description: 'Workspace members with data read access may inspect the conversation, messages, and runs.',
        security: [{ userSession: [] }],
        parameters: [agentConversationIdPathParameter],
        responses: {
          '200': { description: 'Agent conversation detail.' },
          '403': { description: 'Requires workspace read access.' },
          '404': { description: 'Conversation not found.' }
        }
      },
      delete: {
        tags: ['agents'],
        summary: 'Delete an Agent conversation',
        description: 'Only the creator may delete the conversation and delete_sessions is required.',
        security: [{ userSession: [] }],
        parameters: [agentConversationIdPathParameter],
        responses: {
          '204': { description: 'Conversation deleted.' },
          '403': { description: 'Creator ownership or delete_sessions is required.' },
          '409': { description: 'The conversation still has an active run.' }
        }
      }
    },
    '/api/v1/agent-conversations/{conversationId}/access': {
      patch: {
        tags: ['agents'],
        summary: 'Change Agent conversation access mode',
        description: 'Only the creator may change access. read_write requires creator permission and a current Agent policy that allows writes; effective run authority is recomputed for each message.',
        security: [{ userSession: [] }],
        parameters: [agentConversationIdPathParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['accessMode'],
                properties: { accessMode: { type: 'string', enum: ['read_only', 'read_write'] } },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          '200': { description: 'Conversation access changed.' },
          '403': { description: 'Creator ownership and the matching run capability are required.' },
          '409': { description: 'The current Agent policy is read-only or the Agent is unavailable.' }
        }
      }
    },
    '/api/v1/agent-conversations/{conversationId}/messages': {
      post: {
        tags: ['agents'],
        summary: 'Continue an Agent conversation',
        description: 'Only the creator may dispatch a message. The current Agent definition and actor permissions are resolved for each run, then pinned immutably on that run.',
        security: [{ userSession: [] }],
        parameters: [agentConversationIdPathParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  content: { type: 'string', minLength: 1, maxLength: 32768 },
                  clientRequestId: { type: 'string', minLength: 1, maxLength: 128 }
                },
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          '202': { description: 'Agent conversation message accepted as an interactive run.' },
          '403': { description: 'Only the creator may continue the conversation.' },
          '409': { description: 'The Agent is unavailable, its policy no longer permits the requested access, or runtime readiness failed.' }
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
        description: 'Workspace Agents accept definition edits, including defaults created with a workspace. MCP servers and skills are managed through the nested Agent capability APIs.',
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
          '409': { description: 'The requested change conflicts with an active assignment or policy.' }
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
          '409': { description: 'The Agent is still assigned to dependent workflows or has active direct-conversation runs.' }
        }
      }
    },
    '/api/v1/agents/{agentId}/duplicate': {
      post: {
        tags: ['agents'],
        summary: 'Duplicate an agent as a manual draft',
        description: 'Copies the effective definition only. Runs, triggers, activity, schedules, and origin attribution are not copied.',
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
  };
}
