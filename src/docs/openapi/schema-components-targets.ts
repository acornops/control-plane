import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';
import { targetSummarySchema, runSchema, userSchema } from './schema-components-common.js';

export function buildTargetRuntimeSchemas(): Record<string, JsonSchema> {
  return {
    TargetSummary: targetSummarySchema,
    TargetPage: pageOf('TargetSummary'),
    SnapshotReference: {
      type: 'object',
      properties: {
        workspaceId: uuid,
        clusterId: uuid,
        targetId: uuid,
        timestamp: dateTime
      },
      additionalProperties: true
    },
    KubernetesCluster: {
      allOf: [targetSummarySchema],
      properties: {
        namespaceInclude: stringArray,
        namespaceExclude: stringArray,
        writeConfirmationPolicy: jsonObject
      }
    },
    KubernetesClusterPage: pageOf('KubernetesCluster'),
    ClusterRegistration: {
      type: 'object',
      required: ['cluster', 'agentKey', 'installInstructions'],
      properties: {
        cluster: schemaRef('KubernetesCluster'),
        agentKey: { type: 'string' },
        installInstructions: schemaRef('InstallInstructions')
      },
      additionalProperties: true
    },
    VirtualMachine: {
      allOf: [targetSummarySchema],
      properties: {
        hostname: { type: 'string' },
        osFamily: { type: 'string', enum: ['linux'] },
        serviceManager: { type: 'string', enum: ['systemd'] },
        allowedLogSources: stringArray
      }
    },
    VirtualMachinePage: pageOf('VirtualMachine'),
    VirtualMachineRegistration: {
      type: 'object',
      required: ['virtualMachine', 'agentKey', 'installInstructions'],
      properties: {
        virtualMachine: schemaRef('VirtualMachine'),
        agentKey: { type: 'string' },
        installInstructions: schemaRef('InstallInstructions')
      },
      additionalProperties: true
    },
    InstallInstructions: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        environment: { type: 'object', additionalProperties: { type: 'string' } }
      },
      additionalProperties: true
    },
    AgentKeyRotation: {
      type: 'object',
      required: ['agentKey', 'keyVersion'],
      properties: {
        clusterId: uuid,
        vmId: uuid,
        targetId: uuid,
        agentKey: { type: 'string' },
        keyVersion: { type: 'integer' },
        installInstructions: schemaRef('InstallInstructions')
      },
      additionalProperties: true
    },
    InventoryItem: { type: 'object', additionalProperties: true },
    InventoryPage: pageOf('InventoryItem'),
    Finding: { type: 'object', additionalProperties: true },
    FindingPage: pageOf('Finding'),
    Investigation: { type: 'object', additionalProperties: true },
    InvestigationPage: pageOf('Investigation'),
    PodLogs: {
      type: 'object',
      required: ['name', 'namespace', 'logs', 'fetchedAt'],
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        container: { type: 'string' },
        logs: { type: 'string' },
        tailLines: { type: 'integer' },
        previous: { type: 'boolean' },
        fetchedAt: dateTime
      },
      additionalProperties: true
    },
    VmLogs: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: jsonObject },
        fetchedAt: dateTime
      },
      additionalProperties: true
    },
    MetricHistory: {
      type: 'object',
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        clusterId: uuid,
        windowMs: { type: 'integer' },
        points: { type: 'array', items: jsonObject },
        items: { type: 'array', items: jsonObject }
      },
      additionalProperties: true
    },
    ChatSession: {
      type: 'object',
      required: ['id', 'workspaceId', 'targetId', 'targetType', 'createdBy'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        clusterId: uuid,
        title: { type: 'string' },
        createdBy: uuid,
        createdByUser: userSchema,
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    ChatSessionPage: pageOf('ChatSession'),
    ChatMessage: {
      type: 'object',
      required: ['id', 'sessionId', 'role', 'content', 'createdAt'],
      properties: {
        id: uuid,
        sessionId: uuid,
        role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
        content: { type: 'string' },
        format: { type: 'string' },
        createdAt: dateTime
      },
      additionalProperties: true
    },
    ChatMessagePage: pageOf('ChatMessage'),
    MessageAccepted: {
      type: 'object',
      required: ['message_id', 'run_id'],
      properties: {
        message_id: uuid,
        run_id: uuid
      }
    },
    TargetChatActivity: {
      type: 'object',
      required: ['targetId', 'targetType', 'windowSeconds', 'generatedAt', 'recentActivity'],
      properties: {
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        windowSeconds: { type: 'integer' },
        generatedAt: dateTime,
        recentActivity: { type: 'array', items: jsonObject }
      },
      additionalProperties: true
    },
    Run: runSchema,
    RunEvent: {
      type: 'object',
      required: ['schema_version', 'run_id', 'seq', 'ts', 'type', 'payload'],
      properties: {
        schema_version: { type: 'integer', enum: [1] },
        run_id: uuid,
        seq: { type: 'integer' },
        ts: dateTime,
        type: { type: 'string' },
        payload: jsonObject
      }
    },
    RunEventPage: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('RunEvent') } },
      additionalProperties: true
    },
    RunApproval: {
      type: 'object',
      required: ['id', 'runId', 'status', 'targetId', 'targetType'],
      properties: {
        id: uuid,
        runId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        clusterId: uuid,
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
        toolName: { type: 'string' },
        createdAt: dateTime,
        expiresAt: dateTime,
        decidedAt: dateTime
      },
      additionalProperties: true
    },
    RunApprovalPage: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: schemaRef('RunApproval') } },
      additionalProperties: true
    },
    ApprovalDecision: {
      type: 'object',
      required: ['approval'],
      properties: {
        approval: schemaRef('RunApproval'),
        conflict: jsonObject
      },
      additionalProperties: true
    },
    ToolCatalog: {
      type: 'object',
      properties: {
        permissions: jsonObject,
        servers: { type: 'array', items: schemaRef('McpServer') },
        serverTools: schemaRef('McpToolPage')
      },
      additionalProperties: true
    },
    ToolSetting: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        capability: { type: 'string', enum: ['read', 'write'] }
      },
      additionalProperties: true
    },
    McpServer: {
      type: 'object',
      required: ['id', 'name', 'url', 'enabled'],
      properties: {
        id: uuid,
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        type: { type: 'string' },
        enabled: { type: 'boolean' },
        authType: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] },
        publicHeaders: { type: 'object', additionalProperties: { type: 'string' } },
        connectionStatus: { type: 'string' },
        lastDiscoveryAt: dateTime,
        lastDiscoveryError: { type: 'string' }
      },
      additionalProperties: true
    },
    McpServerList: {
      type: 'object',
      required: ['servers'],
      properties: { servers: { type: 'array', items: schemaRef('McpServer') } },
      additionalProperties: true
    },
    McpTool: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        capability: { type: 'string', enum: ['read', 'write'] },
        inputSchema: jsonObject,
        enabledConfigured: { type: 'boolean' },
        enabledEffective: { type: 'boolean' }
      },
      additionalProperties: true
    },
    McpToolPage: pageOf('McpTool'),
    McpTestConnection: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        connectionStatus: { type: 'string' },
        tools: { type: 'array', items: schemaRef('McpTool') },
        error: { type: 'string' }
      },
      additionalProperties: true
    },
    WebhookSubscription: {
      type: 'object',
      required: ['id', 'workspaceId', 'url', 'eventTypes', 'enabled'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        targetId: uuid,
        url: { type: 'string', format: 'uri' },
        eventTypes: stringArray,
        enabled: { type: 'boolean' },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WebhookCreated: {
      allOf: [schemaRef('WebhookSubscription')],
      description: 'Webhook subscription response. Includes signing secret once.'
    },
    WebhookPage: pageOf('WebhookSubscription'),
    WebhookHistory: {
      type: 'object',
      properties: {
        id: uuid,
        webhookId: uuid,
        eventType: { type: 'string' },
        status: { type: 'string', enum: ['success', 'failed'] },
        responseStatus: { type: 'integer' },
        deliveredAt: dateTime
      },
      additionalProperties: true
    },
    WebhookHistoryPage: pageOf('WebhookHistory')
  };
}
