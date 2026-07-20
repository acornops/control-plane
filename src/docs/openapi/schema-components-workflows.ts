import { dateTime, JsonSchema, jsonObject, pageOf, schemaRef, stringArray, uuid } from './schema-types.js';

const workflowId = { type: 'string', example: 'workflow-cluster-daily-triage' };
const workflowSessionId = { type: 'string', example: 'workflow-session-01' };

export function buildWorkflowSchemas(): Record<string, JsonSchema> {
  return {
    WorkflowOrigin: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['template', 'manual'] },
        templateId: { type: 'string' },
        templateVersion: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    },
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
      required: ['id', 'workspaceId', 'version', 'origin', 'name', 'status', 'prompt', 'agentIds', 'executionMode', 'resourceRequirements', 'capabilityPolicy', 'requiredPermissions', 'createdBy'],
      properties: {
        id: workflowId,
        workspaceId: uuid,
        version: { type: 'integer', minimum: 1 },
        origin: schemaRef('WorkflowOrigin'),
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'draft', 'paused'] },
        prompt: { type: 'string' },
        agentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        executionMode: { type: 'string', enum: ['direct', 'coordinated'], readOnly: true },
        resourceRequirements: { type: 'array', items: schemaRef('PromptResourceRequirement') },
        capabilityPolicy: schemaRef('WorkflowCapabilityPolicy'),
        tags: stringArray,
        inputs: { type: 'array', items: jsonObject },
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
        source: { type: 'string', enum: ['target', 'mcp', 'builtin'] }
      },
      additionalProperties: false
    },
    WorkflowTargetCapabilityCandidate: {
      type: 'object',
      required: ['id', 'name', 'targetType', 'status'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
        status: { type: 'string', enum: ['ready', 'unavailable', 'unsupported'] },
        reasonCode: { type: 'string', enum: ['TARGET_REQUIRED', 'TARGET_NOT_FOUND', 'TARGET_TYPE_MISMATCH', 'TARGET_OFFLINE', 'TARGET_STATUS_UNKNOWN', 'TARGET_WRITE_UNSUPPORTED', 'CAPABILITY_MAPPING_UNAVAILABLE', 'TARGET_TOOL_MAPPING_UNAVAILABLE', 'TARGET_TOOL_CATALOG_UNAVAILABLE', 'MCP_CONNECTION_UNAVAILABLE'] },
        reason: { type: 'string', maxLength: 256 }
      },
      additionalProperties: false
    },
    WorkflowCapabilitiesPreview: {
      type: 'object',
      required: ['workflowId', 'workflowVersion', 'mode', 'semanticCapabilityIds', 'checkedAt', 'status', 'reasonCodes', 'targetCandidates', 'tools', 'directMcpServers', 'enabledSkills', 'mcpRequirements', 'approvalRequirements', 'counts'],
      properties: {
        workflowId,
        workflowVersion: { type: 'integer', minimum: 1 },
        mode: { type: 'string', enum: ['read_only', 'read_write'] },
        semanticCapabilityIds: stringArray,
        checkedAt: dateTime,
        status: { type: 'string', enum: ['needs_target', 'ready', 'blocked'] },
        reasonCodes: { type: 'array', items: { type: 'string', enum: ['TARGET_REQUIRED', 'TARGET_NOT_FOUND', 'TARGET_TYPE_MISMATCH', 'TARGET_OFFLINE', 'TARGET_STATUS_UNKNOWN', 'TARGET_WRITE_UNSUPPORTED', 'CAPABILITY_MAPPING_UNAVAILABLE', 'TARGET_TOOL_MAPPING_UNAVAILABLE', 'TARGET_TOOL_CATALOG_UNAVAILABLE', 'MCP_CONNECTION_UNAVAILABLE'] } },
        targetCandidates: { type: 'array', items: schemaRef('WorkflowTargetCapabilityCandidate') },
        selectedTarget: schemaRef('WorkflowTargetCapabilityCandidate'),
        compiledAccessScope: jsonObject,
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
            authType: { type: 'string', enum: ['bearer_token', 'custom_header'] },
            owningAgent: {
              type: 'object',
              required: ['id', 'name'],
              properties: {
                id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1, maxLength: 160 }
              },
              additionalProperties: false
            },
            owningTarget: {
              type: 'object',
              required: ['id', 'name', 'targetType'],
              properties: {
                id: { type: 'string', minLength: 1 },
                name: { type: 'string', minLength: 1, maxLength: 160 },
                targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] }
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
          required: ['targets', 'readyTargets', 'tools', 'readTools', 'writeTools', 'directMcpServers', 'enabledSkills', 'approvals'],
          properties: {
            targets: { type: 'integer', minimum: 0 }, readyTargets: { type: 'integer', minimum: 0 },
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
            source: { type: 'string', enum: ['workspace', 'target', 'agent'] },
            provider: { type: 'string', enum: ['github', 'gitlab'] },
            targetId: { type: 'string' },
            targetName: { type: 'string' },
            targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] },
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
        workflowVersion: { type: 'integer' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['enabled', 'paused'] },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        controlMessage: { type: 'string' },
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
    PromptReferenceTypeDescriptor: {
      type: 'object',
      required: ['type', 'displayName', 'description', 'icon', 'placeholderLabel', 'availability', 'minimum', 'maximum', 'allowPinnedReferences', 'provider', 'providerVersion'],
      properties: {
        type: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
        displayName: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' }, placeholderLabel: { type: 'string' },
        availability: { type: 'string', enum: ['available', 'unavailable'] }, unavailableReason: { type: 'string' },
        minimum: { type: 'integer', minimum: 0 }, maximum: { type: 'integer', minimum: 0, maximum: 64 },
        allowPinnedReferences: { type: 'boolean' }, implicit: { type: 'boolean' }, provider: { type: 'string' }, providerVersion: { type: 'string' }
      },
      additionalProperties: false
    },
    PromptReferenceTypeList: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: schemaRef('PromptReferenceTypeDescriptor') } }, additionalProperties: false },
    PromptResourceCandidate: {
      type: 'object', required: ['type', 'id', 'label', 'provider', 'availability'],
      properties: { type: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, provider: { type: 'string' }, availability: { type: 'string', enum: ['available', 'unavailable'] }, unavailableReason: { type: 'string' }, metadata: jsonObject },
      additionalProperties: false
    },
    PromptResourceCandidateList: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: schemaRef('PromptResourceCandidate') } }, additionalProperties: false },
    PromptReferenceResolution: {
      type: 'object', required: ['prompt', 'promptDigest', 'bindingDigest', 'tokens', 'candidates', 'bindings', 'blockers', 'resolvedAt'],
      properties: {
        prompt: { type: 'string' }, promptDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bindingDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        tokens: { type: 'array', items: { type: 'object', required: ['type', 'label', 'start', 'end', 'state'], properties: { type: { type: 'string' }, label: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' }, state: { type: 'string', enum: ['placeholder', 'concrete'] } }, additionalProperties: false } },
        candidates: { type: 'array', items: { oneOf: [schemaRef('PromptResourceCandidate'), { type: 'null' }] } },
        bindings: { type: 'array', items: jsonObject },
        blockers: { type: 'array', items: { type: 'object', required: ['code', 'message', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, tokenIndex: { type: 'integer' }, type: { type: 'string' }, retryable: { type: 'boolean' } }, additionalProperties: false } },
        resolvedAt: dateTime
      }, additionalProperties: false
    },
    WorkflowApprovalInbox: {
      type: 'object',
      required: ['items', 'pendingCount'],
      properties: {
        items: { type: 'array', items: schemaRef('WorkflowApprovalInboxRow') },
        pendingCount: { type: 'integer', minimum: 0 },
        nextCursor: { type: 'string' }
      }
    },
    WorkflowApprovalInboxRow: {
      type: 'object',
      required: ['approvalId', 'runId', 'source', 'status', 'summary'],
      properties: {
        approvalId: uuid,
        runId: uuid,
        source: { type: 'string', enum: ['target_tool', 'workflow_gate', 'agent_gate', 'agent_tool', 'workflow_tool'] },
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
    WorkflowCoordinationChild: {
      type: 'object',
      required: ['id', 'capabilityId', 'target', 'agent', 'required', 'status'],
      properties: {
        id: { type: 'string' },
        childRunId: { type: 'string' },
        capabilityId: { type: 'string' },
        target: {
          type: 'object',
          required: ['id', 'targetType'],
          properties: {
            id: { type: 'string' },
            targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] }
          },
          additionalProperties: false
        },
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
    },
    ReportArtifact: {
      type: 'object',
      required: ['id', 'workspaceId', 'sourceVersion', 'mediaType', 'title', 'sourceSizeBytes', 'retentionExpiresAt', 'createdAt', 'downloadUrl'],
      properties: {
        id: uuid,
        workspaceId: uuid,
        executionId: { type: 'string' },
        runId: { type: 'string' },
        targetRunId: { type: 'string' },
        toolCallId: { type: 'string' },
        sourceVersion: { type: 'integer', minimum: 1 },
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
