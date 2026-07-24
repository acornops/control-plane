import { dateTime, JsonSchema, jsonObject, schemaRef, stringArray } from './schema-types.js';

export function buildAgentSchemas(): Record<string, JsonSchema> {
  return {
    WorkspaceNativeTool: {
      type: 'object',
      required: ['id', 'title', 'description', 'semanticCapabilityId', 'invocationScopes', 'authorizationClass', 'auditOperation', 'approvalOperation', 'inputSchema', 'outputSchema'],
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
        semanticCapabilityId: { type: 'string' },
        invocationScopes: { type: 'array', items: { type: 'string', enum: ['workflow', 'target_chat'] } },
        authorizationClass: { type: 'string', enum: ['selected_context', 'internal_artifact'] },
        auditOperation: { type: 'string', enum: ['read', 'write'] },
        approvalOperation: { type: 'string', enum: ['read', 'write'] },
        requiredContextGrant: { type: 'string' }, inputSchema: jsonObject, outputSchema: jsonObject
      },
      additionalProperties: false
    },
    WorkspaceNativeToolList: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('WorkspaceNativeTool') } },
      additionalProperties: false
    },
    AgentDefinition: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'instructions', 'status', 'origin', 'reviewState', 'providerType', 'version', 'ownerUserId', 'createdBy', 'workflowUsage'],
      properties: {
        id: { type: 'string' },
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        origin: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['template', 'manual'] }, templateId: { type: 'string' }, templateVersion: { type: 'integer', minimum: 1 } }, additionalProperties: false },
        reviewState: { type: 'string', enum: ['draft', 'reviewed'] },
        providerType: { type: 'string', enum: ['internal', 'external'] },
        version: { type: 'integer' },
        ownerUserId: { type: 'string' },
        createdBy: { type: 'string' },
        mcpServers: stringArray,
        mcpTools: { type: 'array', items: {
          type: 'object', required: ['serverId', 'toolName'],
          properties: { serverId: { type: 'string' }, toolName: { type: 'string' } },
          additionalProperties: false
        } },
        mcpInstallations: { type: 'array', items: schemaRef('AgentMcpServer') },
        tools: stringArray,
        skills: stringArray,
        skillInstallations: { type: 'array', items: schemaRef('AgentSkill') },
        contextGrants: stringArray,
        targetScope: jsonObject,
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
        permissionMode: { type: 'string', enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes'] },
        semanticCapabilityIds: stringArray,
        capabilities: { type: 'array', items: schemaRef('AgentCapability') },
        workflowsUsingAgent: stringArray,
        workflowUsage: {
          type: 'object',
          required: ['workflowRunCount'],
          properties: {
            workflowRunCount: { type: 'integer', minimum: 0 },
            lastRunAt: dateTime,
            lastStatus: {
              type: 'string',
              enum: ['queued', 'dispatching', 'running', 'waiting_for_approval', 'needs_review', 'completed', 'failed', 'cancelled']
            }
          },
          additionalProperties: false
        },
        readiness: {
          type: 'object',
          required: ['status', 'reasons'],
          properties: { status: { type: 'string', enum: ['ready', 'needs_setup', 'blocked'] }, reasons: stringArray }
        },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: false
    },
    AgentCapability: {
      type: 'object',
      required: ['source', 'resourceType', 'resourceScope', 'operation', 'requiresApproval'],
      properties: {
        source: { type: 'string', enum: ['builtin_tool', 'mcp_tool', 'skill', 'context', 'target'] },
        providerAgentId: { type: 'string' },
        resourceType: { type: 'string' },
        resourceScope: { type: 'string' },
        toolId: { type: 'string' },
        operation: { type: 'string', enum: ['read', 'write'] },
        requiresApproval: { type: 'boolean' }
      },
      additionalProperties: true
    },
    AgentMutation: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        providerType: { type: 'string', enum: ['internal', 'external'] },
        ownerUserId: { type: 'string' },
        contextGrants: stringArray,
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
        targetScope: jsonObject,
        permissionMode: { type: 'string', enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes'] },
        semanticCapabilityIds: stringArray
      },
      additionalProperties: false,
      description: 'Agent profile and policy fields only. Install MCP servers and skills through the Agent-scoped capability routes.'
    },
    AgentDuplicateMutation: {
      type: 'object',
      required: ['workspaceId'],
      properties: {
        workspaceId: { type: 'string' },
        name: { type: 'string' }
      },
      additionalProperties: false
    },
    AgentVersionSnapshot: {
      type: 'object',
      required: ['id', 'agentId', 'workspaceId', 'version', 'snapshot', 'createdBy', 'createdAt'],
      properties: {
        id: { type: 'string' },
        agentId: { type: 'string' },
        workspaceId: { type: 'string' },
        version: { type: 'integer' },
        snapshot: schemaRef('AgentDefinition'),
        createdBy: { type: 'string' },
        createdAt: dateTime
      },
      additionalProperties: true
    },
    AgentList: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('AgentDefinition') } }
    },
    AgentResponse: {
      type: 'object',
      required: ['agent'],
      properties: { agent: schemaRef('AgentDefinition') }
    },
    AgentVersionResponse: {
      type: 'object',
      required: ['version'],
      properties: { version: schemaRef('AgentVersionSnapshot') }
    },
    AgentVersionList: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('AgentVersionSnapshot') } }
    },
    AgentTestResponse: {
      type: 'object',
      required: ['compiledScope', 'executing', 'deprecated'],
      properties: {
        compiledScope: jsonObject,
        executing: { type: 'boolean', enum: [false] },
        deprecated: { type: 'boolean', enum: [true] }
      }
    },
    AutomationTemplateSummary: {
      type: 'object',
      required: ['id', 'version', 'name', 'description', 'installMode', 'installationStatus', 'setupSteps', 'blockerCodes'],
      properties: {
        id: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        description: { type: 'string' },
        installMode: { type: 'string', enum: ['automatic', 'opt_in'] },
        installationStatus: { type: 'string', enum: ['not_installed', 'needs_setup', 'ready', 'active'] },
        setupSteps: { type: 'array', items: { type: 'string' } },
        blockerCodes: { type: 'array', items: { type: 'string' } },
        workflowId: { type: 'string' }
      },
      additionalProperties: false
    },
    AutomationTemplateInstallation: {
      type: 'object',
      required: ['workspaceId', 'templateId', 'templateVersion', 'state', 'installedBy', 'recordIds', 'installedAt'],
      properties: {
        workspaceId: { type: 'string' },
        templateId: { type: 'string' },
        templateVersion: { type: 'integer', minimum: 1 },
        state: { type: 'string', enum: ['pending', 'complete'] },
        installedBy: { type: 'string' },
        recordIds: { type: 'object', additionalProperties: { type: 'string' } },
        installedAt: dateTime
      },
      additionalProperties: false
    },
    AutomationTemplateCatalog: {
      type: 'object',
      required: ['templates', 'installations'],
      properties: {
        templates: { type: 'array', items: schemaRef('AutomationTemplateSummary') },
        installations: { type: 'array', items: schemaRef('AutomationTemplateInstallation') }
      },
      additionalProperties: false
    },
    AutomationTemplateInstallResult: {
      type: 'object', required: ['workflowId', 'alreadyInstalled'],
      properties: { workflowId: { type: 'string' }, alreadyInstalled: { type: 'boolean' } },
      additionalProperties: false
    },
    AutomationTemplateActivationResult: {
      type: 'object', required: ['workflowId', 'status'],
      properties: { workflowId: { type: 'string' }, status: { type: 'string', enum: ['active'] } },
      additionalProperties: false
    },
    AutomationDiagnostics: {
      type: 'object',
      required: ['status', 'runtime', 'dispatch', 'runs', 'schedules', 'approvals', 'templates', 'reports', 'checkedAt'],
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded', 'disabled'] },
        runtime: jsonObject,
        dispatch: jsonObject,
        runs: jsonObject,
        schedules: jsonObject,
        approvals: jsonObject,
        templates: jsonObject,
        reports: jsonObject,
        checkedAt: dateTime
      },
      additionalProperties: false
    },
    ServiceIdentity: {
      type: 'object', required: ['workspaceId', 'id', 'name', 'status', 'role', 'createdBy', 'createdAt', 'updatedAt'],
      properties: { workspaceId: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['active', 'disabled'] }, role: { type: 'string' }, createdBy: { type: 'string' }, createdAt: dateTime, updatedAt: dateTime },
      additionalProperties: false
    },
    ServiceIdentityList: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: schemaRef('ServiceIdentity') } }, additionalProperties: false },
    ServiceIdentityResponse: { type: 'object', required: ['identity'], properties: { identity: schemaRef('ServiceIdentity') }, additionalProperties: false }
  };
}
