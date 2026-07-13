import { dateTime, JsonSchema, jsonObject, schemaRef, stringArray } from './schema-types.js';

export function buildAgentSchemas(): Record<string, JsonSchema> {
  return {
    AgentDefinition: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'instructions', 'status', 'kind', 'providerType', 'version'],
      properties: {
        id: { type: 'string' },
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        source: { type: 'string', enum: ['system', 'user'] },
        kind: { type: 'string', enum: ['system_orchestrator', 'specialist_agent'] },
        providerType: { type: 'string', enum: ['internal', 'external'] },
        version: { type: 'integer' },
        ownerUserId: { type: 'string' },
        mcpServers: stringArray,
        tools: stringArray,
        skills: stringArray,
        contextGrants: stringArray,
        targetScope: jsonObject,
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
        capabilities: { type: 'array', items: schemaRef('AgentCapability') },
        workflowsUsingAgent: stringArray,
        triggers: { type: 'array', items: schemaRef('AgentTrigger') },
        activity: jsonObject,
        readiness: {
          type: 'object',
          required: ['status', 'reasons'],
          properties: { status: { type: 'string', enum: ['ready', 'needs_setup', 'blocked'] }, reasons: stringArray }
        },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
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
        mcpServers: stringArray,
        tools: stringArray,
        skills: stringArray,
        contextGrants: stringArray,
        approvalPolicy: jsonObject,
        trustPolicy: jsonObject,
        targetScope: jsonObject
      },
      additionalProperties: true
    },
    AgentTrigger: {
      type: 'object',
      required: ['id', 'type', 'enabled'],
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['manual', 'workflow_step', 'schedule', 'webhook', 'target_event'] },
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        schedule: jsonObject,
        eventFilter: jsonObject,
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    AgentActivityRecord: {
      type: 'object',
      required: ['id', 'agentId', 'workspaceId', 'agentVersion', 'status', 'createdAt'],
      properties: {
        id: { type: 'string' },
        agentId: { type: 'string' },
        workspaceId: { type: 'string' },
        agentVersion: { type: 'integer' },
        triggerId: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'waiting_for_approval', 'needs_review', 'completed', 'failed', 'cancelled'] },
        inputContext: jsonObject,
        compiledScope: jsonObject,
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
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
    AgentRunAccepted: {
      type: 'object',
      required: ['runId', 'activityId', 'source', 'status'],
      properties: {
        runId: { type: 'string' }, activityId: { type: 'string' },
        source: { type: 'string', enum: ['agent'] },
        status: { type: 'string', enum: ['queued', 'waiting_for_approval'] }
      }
    },
    AgentActivityList: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('AgentActivityRecord') } }
    },
    AutomationDiagnostics: {
      type: 'object',
      required: ['status', 'runtime', 'dispatch', 'runs', 'triggers', 'approvals', 'templates', 'reports', 'checkedAt'],
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded', 'disabled'] },
        runtime: jsonObject,
        dispatch: jsonObject,
        runs: jsonObject,
        triggers: jsonObject,
        approvals: jsonObject,
        templates: jsonObject,
        reports: jsonObject,
        checkedAt: dateTime
      },
      additionalProperties: false
    },
    AgentTriggerResponse: {
      type: 'object',
      required: ['trigger'],
      properties: { trigger: schemaRef('AgentTrigger') }
    }
  };
}
