import { dateTime, JsonSchema, jsonObject, schemaRef, stringArray } from './schema-types.js';

export function buildAgentSchemas(): Record<string, JsonSchema> {
  return {
    AgentDefinition: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'instructions', 'status', 'providerType', 'version'],
      properties: {
        id: { type: 'string' },
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled', 'draft'] },
        source: { type: 'string', enum: ['system', 'user'] },
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
        triggers: { type: 'array', items: schemaRef('AgentTrigger') },
        activity: jsonObject,
        createdAt: dateTime,
        updatedAt: dateTime
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
        type: { type: 'string', enum: ['manual', 'workflow_step', 'schedule', 'webhook', 'audit_event', 'target_event', 'external_adapter'] },
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
        status: { type: 'string' },
        inputContext: jsonObject,
        compiledScope: jsonObject,
        createdAt: dateTime,
        updatedAt: dateTime
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
      properties: { version: jsonObject }
    },
    AgentTestResponse: {
      type: 'object',
      required: ['activity', 'compiledScope'],
      properties: {
        activity: schemaRef('AgentActivityRecord'),
        compiledScope: jsonObject
      }
    },
    AgentActivityList: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('AgentActivityRecord') } }
    },
    AgentTriggerResponse: {
      type: 'object',
      required: ['trigger'],
      properties: { trigger: schemaRef('AgentTrigger') }
    }
  };
}
