import { dateTime, JsonSchema, jsonObject, schemaRef, stringArray } from './schema-types.js';

export function buildAgentSchemas(): Record<string, JsonSchema> {
  return {
    WorkspaceNativeTool: {
      type: 'object',
      required: ['id', 'modelAlias', 'title', 'description', 'semanticCapabilityId', 'invocationScopes', 'authorizationClass', 'auditOperation', 'approvalOperation', 'inputSchema', 'outputSchema'],
      properties: {
        id: { type: 'string' }, modelAlias: { type: 'string' },
        title: { type: 'string' }, description: { type: 'string' },
        semanticCapabilityId: { type: 'string' },
        invocationScopes: { type: 'array', items: { type: 'string', enum: ['workflow', 'agent_chat'] } },
        authorizationClass: { type: 'string', enum: ['prompt_resource', 'internal_artifact', 'external_http_read'] },
        auditOperation: { type: 'string', enum: ['read', 'write'] },
        approvalOperation: { type: 'string', enum: ['read', 'write'] },
        configSchema: jsonObject,
        inputSchema: jsonObject, outputSchema: jsonObject
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
      required: ['id', 'workspaceId', 'name', 'avatarEmoji', 'instructions', 'status', 'reviewState', 'providerType', 'ownerUserId', 'createdBy', 'nativeToolConfigs'],
      properties: {
        id: { type: 'string' },
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        avatarEmoji: { type: 'string', minLength: 1, maxLength: 64, description: 'Exactly one Unicode emoji grapheme used as the Agent visual identity.' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        reviewState: { type: 'string', enum: ['draft', 'reviewed'] },
        providerType: { type: 'string', enum: ['internal', 'external'] },
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
        nativeToolConfigs: jsonObject,
        skills: stringArray,
        skillInstallations: { type: 'array', items: schemaRef('AgentSkill') },
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
        permissionMode: { type: 'string', enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes'] },
        semanticCapabilityIds: stringArray,
        capabilities: { type: 'array', items: schemaRef('AgentCapability') },
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
        source: { type: 'string', enum: ['builtin_tool', 'mcp_tool', 'skill'] },
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
        avatarEmoji: { type: 'string', minLength: 1, maxLength: 64, description: 'Exactly one Unicode emoji grapheme.' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        providerType: { type: 'string', enum: ['internal', 'external'] },
        ownerUserId: { type: 'string' },
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
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
    AgentConversationSummary: {
      type: 'object',
      required: ['id', 'workspaceId', 'agentId', 'permissionMode', 'title', 'createdBy', 'accessMode', 'createdAt', 'expiresAt', 'status'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        workspaceId: { type: 'string', format: 'uuid' },
        agentId: { type: 'string' },
        permissionMode: { type: 'string', enum: ['read_only', 'ask_before_changes', 'auto_allowed_changes'] },
        title: { type: 'string' },
        createdBy: { type: 'string', format: 'uuid' },
        accessMode: { type: 'string', enum: ['read_only', 'read_write'] },
        launchedAt: dateTime,
        createdAt: dateTime,
        expiresAt: dateTime,
        status: { type: 'string', enum: ['open', 'archived'] }
      },
      additionalProperties: false
    },
    AgentConversationMessageAccepted: {
      type: 'object',
      required: ['message_id', 'run_id', 'status'],
      properties: {
        message_id: { type: 'string', format: 'uuid' },
        run_id: { type: 'string', format: 'uuid' },
        status: { type: 'string' }
      },
      additionalProperties: false
    },
    AgentConversationMessage: {
      type: 'object',
      required: ['id', 'role', 'content', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        role: { type: 'string', enum: ['user', 'assistant', 'system'] },
        content: { type: 'string' },
        runId: { type: 'string', format: 'uuid' },
        createdAt: dateTime
      },
      additionalProperties: true
    },
    AgentConversationRun: {
      type: 'object',
      required: [
        'id', 'workspaceId', 'agentId', 'sessionId', 'messageId',
        'toolAccessMode', 'status', 'requestedAt', 'startedAt', 'endedAt', 'errorCode', 'events'
      ],
      properties: {
        id: { type: 'string', format: 'uuid' },
        workspaceId: { type: 'string', format: 'uuid' },
        agentId: { type: 'string' },
        sessionId: { type: 'string', format: 'uuid' },
        messageId: { type: 'string', format: 'uuid' },
        toolAccessMode: { type: 'string', enum: ['read_only', 'read_write'] },
        status: { type: 'string' },
        requestedAt: dateTime,
        startedAt: { type: ['string', 'null'], format: 'date-time' },
        endedAt: { type: ['string', 'null'], format: 'date-time' },
        errorCode: { type: ['string', 'null'] },
        assistantMessage: jsonObject,
        usage: jsonObject,
        events: { type: 'array', items: schemaRef('RunEvent') }
      },
      additionalProperties: false
    },
    AgentConversationList: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: schemaRef('AgentConversationSummary') }
      },
      additionalProperties: false
    },
    AgentConversationDetail: {
      type: 'object',
      required: ['conversation', 'messages', 'runs'],
      properties: {
        conversation: schemaRef('AgentConversationSummary'),
        messages: { type: 'array', items: schemaRef('AgentConversationMessage') },
        runs: { type: 'array', items: schemaRef('AgentConversationRun') }
      },
      additionalProperties: false
    },
    AgentConversationAccessResponse: {
      type: 'object',
      required: ['conversation'],
      properties: {
        conversation: schemaRef('AgentConversationSummary')
      },
      additionalProperties: false
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
      required: ['id', 'name', 'description', 'installMode', 'installationStatus', 'setupSteps', 'blockerCodes'],
      properties: {
        id: { type: 'string' },
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
      required: ['workspaceId', 'templateId', 'state', 'installedBy', 'recordIds', 'installedAt'],
      properties: {
        workspaceId: { type: 'string' },
        templateId: { type: 'string' },
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
