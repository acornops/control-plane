import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';
import { targetSummarySchema, runSchema, userSchema } from './schema-components-common.js';
import { buildTargetMcpWireSchemas } from './schema-components-target-mcp.js';

export function buildTargetRuntimeSchemas(): Record<string, JsonSchema> {
  return {
    ChatRuntimeSelection: {
      type: 'object',
      required: ['provider', 'model', 'reasoningEffort'],
      properties: {
        provider: { type: 'string', enum: ['openai', 'anthropic', 'gemini'] },
        model: { type: 'string' },
        reasoningEffort: { type: 'string', enum: ['off', 'low', 'medium', 'high'] }
      },
      additionalProperties: false
    },
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
    Issue: { type: 'object', additionalProperties: true },
    IssuePage: pageOf('Issue'),
    TargetIssueSummary: {
      type: 'object',
      required: ['total', 'active', 'recovering', 'critical', 'warning', 'info'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        active: { type: 'integer', minimum: 0 },
        recovering: { type: 'integer', minimum: 0 },
        critical: { type: 'integer', minimum: 0 },
        warning: { type: 'integer', minimum: 0 },
        info: { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    },
    IssueObservation: { type: 'object', additionalProperties: true },
    IssueObservationPage: pageOf('IssueObservation'),
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
        windowMs: { type: 'integer', minimum: 0 },
        points: { type: 'array', items: jsonObject },
        items: { type: 'array', items: jsonObject }
      },
      additionalProperties: true
    },
    VirtualMachineMetricHistoryPoint: {
      type: 'object',
      required: [
        'timestamp',
        'loadAverage1m',
        'loadAverage5m',
        'loadAverage15m',
        'cpuUsagePercent',
        'memoryUsedBytes',
        'memoryTotalBytes',
        'memoryFreeBytes',
        'memoryUsedPercent',
        'swapUsedBytes',
        'swapTotalBytes',
        'swapUsedPercent',
        'rootDiskUsedBytes',
        'rootDiskTotalBytes',
        'rootDiskUsedPercent'
      ],
      properties: {
        timestamp: dateTime,
        loadAverage1m: { type: 'number', minimum: 0, nullable: true },
        loadAverage5m: { type: 'number', minimum: 0, nullable: true },
        loadAverage15m: { type: 'number', minimum: 0, nullable: true },
        cpuUsagePercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
        memoryUsedBytes: { type: 'number', minimum: 0, nullable: true },
        memoryTotalBytes: { type: 'number', minimum: 0, nullable: true },
        memoryFreeBytes: { type: 'number', minimum: 0, nullable: true },
        memoryUsedPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
        swapUsedBytes: { type: 'number', minimum: 0, nullable: true },
        swapTotalBytes: { type: 'number', minimum: 0, nullable: true },
        swapUsedPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true },
        rootDiskUsedBytes: { type: 'number', minimum: 0, nullable: true },
        rootDiskTotalBytes: { type: 'number', minimum: 0, nullable: true },
        rootDiskUsedPercent: { type: 'number', minimum: 0, maximum: 100, nullable: true }
      },
      additionalProperties: false
    },
    VirtualMachineMetricHistory: {
      type: 'object',
      required: ['workspaceId', 'targetId', 'windowMs', 'points'],
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        windowMs: { type: 'integer', minimum: 0 },
        points: { type: 'array', items: schemaRef('VirtualMachineMetricHistoryPoint') }
      },
      additionalProperties: false
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
        lastRuntimeSelection: schemaRef('ChatRuntimeSelection'),
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
      required: ['message_id', 'run_id', 'runtimeSelection'],
      properties: {
        message_id: uuid,
        run_id: uuid,
        runtimeSelection: schemaRef('ChatRuntimeSelection')
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
        summary: { type: 'string', description: 'Human-readable, non-authoritative description of the pending write action.' },
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
    McpCatalog: {
      type: 'object',
      properties: {
        permissions: jsonObject,
        servers: { type: 'array', items: schemaRef('McpServer') },
        serverTools: schemaRef('McpToolPage')
      },
      additionalProperties: true
    },
    TargetToolCatalog: {
      type: 'object',
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        permissions: jsonObject,
        items: { type: 'array', items: schemaRef('TargetTool') }
      },
      additionalProperties: true
    },
    TargetAssistantCapabilitiesPreview: {
      type: 'object',
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        toolAccessMode: { type: 'string', enum: ['read_only', 'read_write'] },
        confirmationRequiredForWrite: { type: 'boolean' },
        writeUnavailableReason: { type: 'string', enum: ['run_read_only', 'agent_write_disabled'], nullable: true },
        toolSummary: {
          type: 'object',
          properties: {
            totalAllowed: { type: 'integer' },
            readAllowed: { type: 'integer' },
            writeAllowed: { type: 'integer' },
            nativeAllowed: { type: 'integer' }
          },
          additionalProperties: true
        },
        skillSummary: {
          type: 'object',
          properties: {
            totalAvailable: { type: 'integer' }
          },
          additionalProperties: true
        },
        tools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
              capability: { type: 'string', enum: ['read', 'write'] },
              runtimeKind: { type: 'string', enum: ['function', 'provider_native'] },
              source: { type: 'string', enum: ['builtin', 'mcp', 'provider_native'] }
            },
            additionalProperties: true
          }
        },
        skills: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              source: { type: 'string', enum: ['manual', 'git_import'] }
            },
            additionalProperties: true
          }
        }
      },
      additionalProperties: true
    },
    TargetTool: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        description: { type: 'string' },
        enabled: { type: 'boolean', default: true },
        origin: { type: 'string', enum: ['target_setting', 'platform_native'] },
        capability: { type: 'string', enum: ['read', 'write'] },
        runtimeKind: { type: 'string', enum: ['provider_native', 'function'] },
        visibility: {
          type: 'object',
          properties: {
            appearsInAssistantToolList: { type: 'boolean' },
            appearsInRunEnabledTools: { type: 'boolean' },
            appearsInToolCalls: { type: 'boolean' }
          },
          additionalProperties: true
        },
        permissions: jsonObject,
        readiness: jsonObject,
        config: jsonObject
      },
      additionalProperties: true
    },
    TargetInsightsEntry: {
      type: 'object',
      required: ['id', 'workspaceId', 'targetId', 'targetType', 'title', 'status', 'bodyMarkdown'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        title: { type: 'string' },
        status: { type: 'string', enum: ['active', 'pending', 'archived'] },
        bodyMarkdown: { type: 'string' },
        frontmatter: jsonObject,
        tags: stringArray,
        signals: jsonObject,
        scope: jsonObject,
        evidenceSummary: { type: 'string' },
        observationCount: { type: 'integer', minimum: 0 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        firstObservedAt: dateTime,
        lastObservedAt: dateTime,
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    TargetInsightsCatalog: {
      type: 'object',
      required: ['workspaceId', 'targetId', 'targetType', 'permissions', 'items'],
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        permissions: jsonObject,
        items: { type: 'array', items: schemaRef('TargetInsightsEntry') }
      },
      additionalProperties: true
    },
    TargetInsightsResetResult: {
      type: 'object',
      required: ['status', 'deletedEntries', 'deletedCheckpoints'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        deletedEntries: { type: 'integer', minimum: 0 },
        deletedCheckpoints: { type: 'integer', minimum: 0 }
      },
      additionalProperties: true
    },
    TargetInsightsActivity: {
      type: 'object',
      required: ['workspaceId', 'targetId', 'items'],
      properties: {
        workspaceId: uuid,
        targetId: uuid,
        items: { type: 'array', items: schemaRef('WorkspaceAuditEvent') }
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
        isSystem: { type: 'boolean' },
        canDelete: { type: 'boolean' },
        canEditConnection: { type: 'boolean' },
        canToggle: { type: 'boolean' },
        authType: { type: 'string', enum: ['none', 'bearer_token', 'custom_header'] },
        authScope: { type: 'string', enum: ['none', 'personal', 'legacy_shared'] },
        provenance: { type: 'object', required: ['sourceId', 'artifactName', 'version', 'digest', 'importedAt'], properties: { sourceId: uuid, artifactName: { type: 'string' }, version: { type: 'string' }, digest: { type: 'string' }, importedAt: dateTime }, additionalProperties: false },
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
        serverId: uuid,
        modelAlias: { type: 'string' },
        description: { type: 'string' },
        capability: { type: 'string', enum: ['read', 'write'] },
        inputSchema: jsonObject,
        enabledConfigured: { type: 'boolean' },
        enabledEffective: { type: 'boolean' },
        effectiveDisabledReason: { type: 'string', enum: ['server_disabled', 'agent_write_disabled'], nullable: true }
      },
      additionalProperties: true
    },
    McpToolPage: pageOf('McpTool'),
    ...buildTargetMcpWireSchemas(),
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
