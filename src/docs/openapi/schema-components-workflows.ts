import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';
import { buildWorkflowWebhookSchemas } from './schema-components-workflow-webhooks.js';
import { buildWorkflowActivitySchemas } from './schema-components-workflow-activity.js';

const workflowId = { type: 'string', example: 'workflow-cluster-daily-triage' };
const workflowSessionId = { type: 'string', example: 'workflow-session-01' };

export function buildWorkflowSchemas(): Record<string, JsonSchema> {
  return {
    ...buildWorkflowWebhookSchemas(),
    ...buildWorkflowActivitySchemas(),
    PromptResourceRequirement: {
      type: 'object',
      required: ['type', 'minimum', 'maximum', 'requiredOperations'],
      properties: {
        type: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
        minimum: { type: 'integer', minimum: 0 },
        maximum: { type: 'integer', minimum: 0, maximum: 64 },
        requiredOperations: stringArray,
        constraints: jsonObject
      },
      additionalProperties: false
    },
    WorkflowCapabilityPolicy: {
      type: 'object',
      required: ['mode', 'restrictionMode', 'semanticCapabilityIds', 'contextGrants', 'maxRuntimeSeconds', 'retentionDays', 'approvalRequirements'],
      properties: {
        mode: { type: 'string', enum: ['read_only', 'read_write'] },
        restrictionMode: { type: 'string', enum: ['inherit', 'restrict'], description: 'inherit resolves the selected Agents current combined ceiling. restrict uses semanticCapabilityIds as an explicit subset, including an intentionally empty subset.' },
        semanticCapabilityIds: { ...stringArray, description: 'Must be empty when restrictionMode is inherit.' },
        contextGrants: stringArray,
        maxRuntimeSeconds: {
          type: 'integer',
          minimum: 1,
          description: 'Effective deployment-wide execution limit. Workflow mutations cannot override this value.'
        },
        retentionDays: {
          type: 'integer',
          minimum: 1,
          description: 'Effective deployment-wide report retention period. Workflow mutations cannot override this value.'
        },
        approvalRequirements: stringArray
      },
      additionalProperties: false
    },
    WorkflowDefinition: {
      type: 'object',
      required: ['id', 'workspaceId', 'name', 'status', 'prompt', 'agentIds', 'executionMode', 'capabilityPolicy', 'requiredPermissions', 'createdBy'],
      properties: {
        id: workflowId,
        workspaceId: uuid,
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'draft', 'paused'] },
        prompt: { type: 'string' },
        agentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        executionMode: { type: 'string', enum: ['direct', 'coordinated'], readOnly: true },
        capabilityPolicy: schemaRef('WorkflowCapabilityPolicy'),
        tags: stringArray,
        requiredPermissions: stringArray,
        createdBy: { type: 'string' },
        createdAt: dateTime,
        updatedAt: dateTime,
        readiness: { type: 'object', required: ['status', 'reasons'], properties: {
          status: { type: 'string', enum: ['ready', 'needs_setup', 'blocked'] }, reasons: stringArray
        } }
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
    WorkflowCapabilityToolPreview: {
      type: 'object',
      required: ['id', 'name', 'label', 'access', 'source'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string' },
        description: { type: 'string' },
        access: { type: 'string', enum: ['read', 'write'] },
        source: { type: 'string', enum: ['mcp', 'builtin'] },
        serverId: { type: 'string' },
        serverIds: { type: 'array', items: { type: 'string' }, uniqueItems: true }
      },
      additionalProperties: false
    },
    WorkflowCapabilitiesPreview: {
      type: 'object',
      required: ['workflowId', 'promptDigest', 'bindingDigest', 'mode', 'semanticCapabilityIds', 'checkedAt', 'status', 'reasonCodes', 'tools', 'directMcpServers', 'enabledSkills', 'mcpRequirements', 'approvalRequirements', 'counts'],
      properties: {
        workflowId,
        promptDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        bindingDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        mode: { type: 'string', enum: ['read_only', 'read_write'] },
        semanticCapabilityIds: stringArray,
        checkedAt: dateTime,
        status: { type: 'string', enum: ['ready', 'blocked'] },
        reasonCodes: { type: 'array', items: { type: 'string', enum: ['CAPABILITY_MAPPING_UNAVAILABLE', 'MCP_CONNECTION_UNAVAILABLE'] } },
        tools: {
          type: 'object',
          required: ['read', 'write'],
          properties: {
            read: { type: 'array', items: schemaRef('WorkflowCapabilityToolPreview') },
            write: { type: 'array', items: schemaRef('WorkflowCapabilityToolPreview') }
          },
          additionalProperties: false
        },
        directMcpServers: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false } },
        enabledSkills: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false } },
        mcpRequirements: { type: 'array', items: {
          type: 'object',
          required: ['serverId', 'serverName', 'authType', 'connectionState', 'authRequirement', 'action'],
          properties: {
            serverId: { type: 'string', minLength: 1 },
            serverName: { type: 'string', minLength: 1, maxLength: 160 },
            authType: { type: 'string', enum: ['bearer_token', 'custom_header', 'oauth'] },
            owningAgent: {
              type: 'object',
              required: ['id', 'name'],
              properties: {
                id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1, maxLength: 160 }
              },
              additionalProperties: false
            },
            connectionState: { type: 'string', enum: ['connection_missing', 'connection_error', 'connected'] },
            authRequirement: {
              type: 'object',
              required: ['scope', 'credentialLabel', 'requiredInformation'],
              properties: {
                scope: { type: 'string', enum: ['workspace', 'individual'] },
                credentialLabel: { type: 'string', minLength: 1, maxLength: 160 },
                requiredInformation: { type: 'array', items: {
                  type: 'object',
                  required: ['name', 'description'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 160 },
                    description: { type: 'string', minLength: 1, maxLength: 512 }
                  },
                  additionalProperties: false
                } }
              },
              additionalProperties: false
            },
            action: { type: 'string', enum: ['connect_mcp_server', 'verify_mcp_server', 'none'] }
          }, additionalProperties: false
        } },
        approvalRequirements: stringArray,
        counts: {
          type: 'object',
          required: ['tools', 'readTools', 'writeTools', 'directMcpServers', 'enabledSkills', 'approvals'],
          properties: {
            tools: { type: 'integer', minimum: 0 }, readTools: { type: 'integer', minimum: 0 }, writeTools: { type: 'integer', minimum: 0 },
            directMcpServers: { type: 'integer', minimum: 0 }, enabledSkills: { type: 'integer', minimum: 0 }, approvals: { type: 'integer', minimum: 0 }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    WorkflowOption: {
      type: 'object',
      required: ['value', 'label'],
      properties: {
        value: { type: 'string' },
        label: { type: 'string' },
        description: { type: 'string' },
        disabled: { type: 'boolean' },
        disabledReason: { type: 'string' },
        provenance: {
          type: 'object',
          required: ['source'],
          properties: {
            source: { type: 'string', enum: ['workspace', 'agent'] },
            provider: { type: 'string', enum: ['github', 'gitlab'] },
            agentId: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: true
    },
    WorkflowOptionsCatalog: {
      type: 'object',
      properties: {
        mcpServers: { type: 'array', items: schemaRef('WorkflowOption') },
        mcpTools: { type: 'array', items: schemaRef('WorkflowOption') },
        skills: { type: 'array', items: schemaRef('WorkflowOption') },
        agents: { type: 'array', items: schemaRef('WorkflowOption') },
        outputFormats: { type: 'array', items: schemaRef('WorkflowOption') },
        approvalPolicies: { type: 'array', items: schemaRef('WorkflowOption') },
        runtimeLimits: { type: 'array', items: schemaRef('WorkflowOption') },
        retentionPolicies: { type: 'array', items: schemaRef('WorkflowOption') },
        sourceAvailability: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['available', 'empty', 'unavailable', 'error'] },
              message: { type: 'string' },
              retryable: { type: 'boolean' },
              errorCode: { type: 'string' }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: true
    },
    WorkflowSchedule: {
      type: 'object',
      properties: {
        id: uuid,
        workspaceId: uuid,
        workflowId,
        name: { type: 'string' },
        status: { type: 'string', enum: ['enabled', 'paused'] },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        approvedContextGrants: stringArray,
        principal: {
          type: 'object',
          required: ['type', 'id'],
          properties: {
            type: { type: 'string', enum: ['user'] },
            id: { type: 'string' }
          },
          additionalProperties: false
        },
        nextRunAt: dateTime,
        lastRunAt: dateTime,
        lastStatus: { type: 'string', enum: ['dispatched', 'failed', 'auto_paused', 'skipped'] },
        lastExecutionId: { type: 'string' },
        lastRunId: { type: 'string' },
        latestExecution: { oneOf: [schemaRef('WorkflowExecutionSummary'), { type: 'null' }] },
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
    WorkflowSchedulePreview: {
      type: 'object',
      required: ['valid', 'summary', 'nextRunTimes', 'errors'],
      properties: {
        valid: { type: 'boolean' },
        summary: { type: 'string' },
        nextRunTimes: { type: 'array', items: dateTime },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'message'],
            properties: { field: { type: 'string' }, message: { type: 'string' } },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    WorkspaceApprovalInbox: {
      type: 'object',
      required: ['items', 'pendingCount'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkspaceApprovalInboxRow') },
        pendingCount: { type: 'integer', minimum: 0 },
        nextCursor: { type: 'string' }
      }
    },
    WorkspaceApprovalInboxRow: {
      type: 'object',
      required: ['approvalId', 'runId', 'source', 'status', 'summary'],
      properties: {
        approvalId: uuid,
        runId: uuid,
        source: { type: 'string', enum: ['interactive_tool', 'workflow_gate', 'agent_gate', 'agent_tool', 'workflow_tool'] },
        workflowId,
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
      required: ['id', 'workspaceId', 'workflowId', 'createdBy'],
      properties: {
        id: workflowSessionId,
        workspaceId: uuid,
        workflowId,
        createdBy: uuid,
        launchedAt: dateTime,
        runs: { type: 'array', items: jsonObject },
        createdAt: dateTime,
        updatedAt: dateTime
      },
      additionalProperties: true
    },
    WorkflowSessionList: pageOf('WorkflowSession'),
    WorkflowSessionResponse: {
      type: 'object',
      required: ['session'],
      properties: {
        session: schemaRef('WorkflowSession')
      },
      additionalProperties: true
    },
    WorkflowMessageAccepted: {
      type: 'object',
      required: ['message_id', 'run_id', 'executionId', 'status'],
      properties: {
        message_id: uuid,
        run_id: uuid,
        executionId: { type: 'string' },
        status: { type: 'string' }
      },
      additionalProperties: true
    },
    WorkflowCoordinationChild: {
      type: 'object',
      required: ['id', 'capabilityId', 'agent', 'required', 'status'],
      properties: {
        id: { type: 'string' },
        childRunId: { type: 'string' },
        capabilityId: { type: 'string' },
        agent: {
          type: 'object',
          required: ['id', 'name'],
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          additionalProperties: false
        },
        required: { type: 'boolean' },
        status: { type: 'string', enum: ['queued', 'dispatching', 'running', 'waiting_for_approval', 'needs_review', 'completed', 'failed', 'cancelled'] },
        failure: {
          type: 'object',
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string', maxLength: 500 } },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    WorkflowCoordinationSummary: {
      type: 'object',
      required: ['label', 'status', 'children'],
      properties: {
        label: { type: 'string', enum: ['AcornOps coordination'] },
        status: { type: 'string' },
        children: { type: 'array', items: schemaRef('WorkflowCoordinationChild') }
      },
      additionalProperties: false
    },
    WorkflowRunContext: {
      type: 'object',
      required: ['messages', 'resources', 'summaries', 'attachments'],
      properties: {
        messages: { type: 'array', items: jsonObject },
        resources: { type: 'array', items: jsonObject },
        summaries: { type: 'array', items: jsonObject },
        attachments: { type: 'array', items: jsonObject }
      },
      additionalProperties: false
    },
    ReportArtifact: {
      type: 'object',
      required: ['id', 'workspaceId', 'mediaType', 'title', 'sourceSizeBytes', 'retentionExpiresAt', 'createdAt', 'downloadUrl'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        workflowExecutionId: { type: 'string' },
        workflowRunId: { type: 'string' },
        conversationRunId: { type: 'string' },
        toolCallId: { type: 'string' },
        mediaType: { type: 'string', enum: ['application/pdf'] },
        title: { type: 'string' },
        sourceSizeBytes: { type: 'integer', minimum: 0 },
        retentionExpiresAt: dateTime,
        createdAt: dateTime,
        downloadUrl: { type: 'string', pattern: '^/api/v1/report-artifacts/.+/download$' }
      },
      additionalProperties: false
    },
    ReportArtifactResponse: {
      type: 'object',
      required: ['report'],
      properties: { report: schemaRef('ReportArtifact') },
      additionalProperties: false
    }
  };
}
