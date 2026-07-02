import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';

const workflowId = { type: 'string', example: 'workflow-cluster-daily-triage' };
const workflowSessionId = { type: 'string', example: 'workflow-session-01' };
const mcpServerId = { type: 'string', example: 'workflow-mcp-prometheus' };

export function buildWorkflowSchemas(): Record<string, JsonSchema> {
  return {
    WorkflowStep: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        requiredInputs: stringArray,
        agentIds: stringArray,
        enabledSkills: stringArray,
        allowedMcpServers: stringArray,
        allowedTools: stringArray,
        contextGrants: stringArray,
        approvalRequired: { type: 'boolean' },
        outputArtifacts: { type: 'array', items: jsonObject }
      },
      additionalProperties: true
    },
    WorkflowDefinition: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'version', 'category', 'policy', 'steps'],
      properties: {
        id: workflowId,
        workspaceId: uuid,
        name: { type: 'string' },
        description: { type: 'string' },
        version: { type: 'integer' },
        source: { type: 'string', enum: ['system', 'user'] },
        status: { type: 'string', enum: ['active', 'draft', 'paused'] },
        category: { type: 'string' },
        tags: stringArray,
        inputs: { type: 'array', items: jsonObject },
        enabledMcpServers: stringArray,
        enabledSkills: stringArray,
        requiredPermissions: stringArray,
        policy: jsonObject,
        steps: { type: 'array', items: schemaRef('WorkflowStep') },
        starterPrompt: { type: 'string' },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WorkflowDefinitionList: pageOf('WorkflowDefinition'),
    WorkflowDefinitionResponse: {
      type: 'object',
      required: ['workflow'],
      properties: { workflow: schemaRef('WorkflowDefinition') },
      additionalProperties: true
    },
    WorkflowOption: {
      type: 'object',
      required: ['value', 'label'],
      properties: {
        value: { type: 'string' },
        label: { type: 'string' },
        group: { type: 'string' },
        disabled: { type: 'boolean' },
        metadata: jsonObject
      },
      additionalProperties: true
    },
    WorkflowOptionsCatalog: {
      type: 'object',
      properties: {
        clusters: { type: 'array', items: schemaRef('WorkflowOption') },
        repositories: { type: 'array', items: schemaRef('WorkflowOption') },
        mcpServers: { type: 'array', items: schemaRef('WorkflowOption') },
        mcpTools: { type: 'array', items: schemaRef('WorkflowOption') },
        skills: { type: 'array', items: schemaRef('WorkflowOption') },
        agents: { type: 'array', items: schemaRef('WorkflowOption') },
        chatSessions: { type: 'array', items: schemaRef('WorkflowOption') },
        outputFormats: { type: 'array', items: schemaRef('WorkflowOption') },
        approvalPolicies: { type: 'array', items: schemaRef('WorkflowOption') },
        runtimeLimits: { type: 'array', items: schemaRef('WorkflowOption') },
        retentionPolicies: { type: 'array', items: schemaRef('WorkflowOption') }
      },
      additionalProperties: true
    },
    WorkflowMcpServer: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'url', 'enabled', 'status'],
      properties: {
        id: mcpServerId,
        workspaceId: uuid,
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        enabled: { type: 'boolean' },
        status: { type: 'string', enum: ['connected', 'disabled'] },
        authType: { type: 'string' },
        publicHeaders: jsonObject,
        tools: { type: 'array', items: schemaRef('WorkflowMcpTool') },
        createdAt: dateTime,
        updatedAt: dateTime,
        lastCheckedAt: dateTime
      },
      additionalProperties: true
    },
    WorkflowMcpServerList: pageOf('WorkflowMcpServer'),
    WorkflowMcpServerResponse: {
      type: 'object',
      required: ['server'],
      properties: { server: schemaRef('WorkflowMcpServer') },
      additionalProperties: true
    },
    WorkflowMcpConnectionTest: {
      type: 'object',
      required: ['serverId', 'status', 'message'],
      properties: {
        serverId: mcpServerId,
        status: { type: 'string' },
        checkedAt: dateTime,
        message: { type: 'string' }
      },
      additionalProperties: true
    },
    WorkflowMcpTool: {
      type: 'object',
      required: ['name', 'serverId', 'capability', 'enabled'],
      properties: {
        name: { type: 'string' },
        serverId: mcpServerId,
        description: { type: 'string' },
        capability: { type: 'string', enum: ['read', 'write'] },
        enabled: { type: 'boolean' }
      },
      additionalProperties: true
    },
    WorkflowMcpToolList: pageOf('WorkflowMcpTool'),
    WorkflowSchedule: {
      type: 'object',
      properties: {
        id: uuid,
        workspaceId: uuid,
        workflowId,
        workflowVersion: { type: 'integer' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['enabled', 'paused'] },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        inputDefaults: jsonObject,
        approvedContextGrants: stringArray,
        nextRunAt: dateTime,
        lastRunAt: dateTime,
        lastStatus: { type: 'string', enum: ['dispatched', 'failed', 'auto_paused', 'skipped'] },
        lastError: { type: 'string' }
      },
      additionalProperties: true
    },
    WorkflowScheduleList: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkflowSchedule') },
        summary: jsonObject
      },
      additionalProperties: true
    },
    WorkflowScheduleResponse: {
      type: 'object',
      required: ['schedule'],
      properties: { schedule: schemaRef('WorkflowSchedule') },
      additionalProperties: true
    },
    WorkflowApprovalInbox: pageOf('WorkflowApprovalInboxRow'),
    WorkflowApprovalInboxRow: {
      type: 'object',
      required: ['approvalId', 'runId', 'source', 'status', 'summary'],
      properties: {
        approvalId: uuid,
        runId: uuid,
        source: { type: 'string', enum: ['target_tool', 'workflow_gate'] },
        workflowId,
        targetId: uuid,
        targetType: { type: 'string' },
        summary: { type: 'string' },
        toolName: { type: 'string' },
        requestedBy: { type: 'string' },
        expiresAt: dateTime,
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        decidedBy: { type: 'string' },
        decidedAt: dateTime,
        requestedAt: dateTime
      },
      additionalProperties: true
    },
    WorkflowSession: {
      type: 'object',
      required: ['id', 'workspaceId', 'workflowId', 'workflowVersion', 'createdBy'],
      properties: {
        id: workflowSessionId,
        workspaceId: uuid,
        workflowId,
        workflowVersion: { type: 'integer' },
        createdBy: uuid,
        compiledAccessScope: jsonObject,
        runs: { type: 'array', items: jsonObject },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WorkflowSessionList: pageOf('WorkflowSession'),
    WorkflowSessionResponse: {
      type: 'object',
      required: ['session', 'compiledAccessScope'],
      properties: {
        session: schemaRef('WorkflowSession'),
        compiledAccessScope: jsonObject
      },
      additionalProperties: true
    },
    WorkflowMessageAccepted: {
      type: 'object',
      required: ['message_id', 'run_id', 'workflow_run_id', 'status'],
      properties: {
        message_id: uuid,
        run_id: uuid,
        workflow_run_id: { type: 'string' },
        status: { type: 'string' },
        compiledAccessScope: jsonObject
      },
      additionalProperties: true
    },
    WorkflowSessionContext: {
      type: 'object',
      required: ['session', 'workflow', 'compiledAccessScope'],
      properties: {
        session: schemaRef('WorkflowSession'),
        workflow: schemaRef('WorkflowDefinition'),
        run: jsonObject,
        compiledAccessScope: jsonObject,
        messages: { type: 'array', items: jsonObject }
      },
      additionalProperties: true
    }
  };
}
