import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { intersectGrantedTargetRunTools, resolveTargetRunTools, WEB_SEARCH_TOOL_ID } from '../services/target-run-tool-resolution.js';
import { gatewayTokenService } from '../services/token-service.js';
import { workflowRunAgentClaims } from '../services/workflow-run-agent-claims.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, getWorkflowSession, WorkflowRunRecord } from '../store/repository-workflows.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import { isTargetType } from '../types/domain.js';
import { targetAssistantContract } from '../services/target-adapter-contract.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';
import { bootstrapAgentRun } from './internal-agent-bootstrap.js';
import { getWorkspaceNativeTool } from '../services/workspace-native-tools.js';

const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';

async function bootstrapWorkflowRun(run: WorkflowRunRecord, res: Response): Promise<void> {
  const session = await getWorkflowSession(run.workflowSessionId);
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workflow session not found for run', retryable: false } });
    return;
  }

  const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId, run.llmProvider && run.llmModel
    ? {
        provider: run.llmProvider,
        model: run.llmModel,
        reasoningSummaryMode: run.llmReasoningSummaryMode,
        reasoningEffort: run.llmReasoningEffort
      }
    : undefined);
  const allowedProviders = llmSettings.allowedProviders;
  const allowedModels = llmSettings.allowedModels;
  if (!allowedProviders.includes(llmSettings.provider)) {
    res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Workspace AI provider is not enabled', retryable: false } });
    return;
  }
  if (!allowedModels.includes(llmSettings.model)) {
    res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not allowed', retryable: false } });
    return;
  }
  if (!isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedProviderModels)) {
    res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not available for the selected provider', retryable: false } });
    return;
  }
  if (!llmSettings.credentialConfigured) {
    res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Workspace AI provider credential is not configured', retryable: false } });
    return;
  }

  const maxOutputTokens = config.LLM_MAX_OUTPUT_TOKENS;
  const workflowMcpRefs = run.compiledAccessScope.mcpTools || [];
  const workflowMcpRefKeys = new Set(workflowMcpRefs.map((ref) => `${ref.serverId}\u0000${ref.toolName}`));
  const workflowAgentSnapshot = run.agentSnapshot as unknown as AgentDefinition | undefined;
  const workflowMcpTools = (workflowAgentSnapshot?.mcpInstallations || []).flatMap((installation) => {
    const constraints = installation.targetConstraints;
    const targetAllowed = (!constraints.targetIds.length || Boolean(run.targetId && constraints.targetIds.includes(run.targetId)))
      && (!constraints.targetTypes.length || Boolean(run.targetType && constraints.targetTypes.some((type) => type === run.targetType)));
    if (!installation.enabled || !targetAllowed) return [];
    return installation.tools.filter((tool) => tool.enabled && tool.reviewState === 'approved'
      && workflowMcpRefKeys.has(`${tool.serverId}\u0000${tool.toolName}`));
  });
  const workflowRemoteAliases = new Set(workflowMcpTools.map((tool) => tool.alias));
  const workspaceNativeToolDefinitions = run.compiledAccessScope.tools
    .map((toolId) => getWorkspaceNativeTool(toolId))
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
  const workspaceNativeToolIds = new Set(workspaceNativeToolDefinitions.map((tool) => tool.id));
  const providerNativeToolIds = new Set<string>(
    run.compiledAccessScope.tools.filter((tool) => tool === WEB_SEARCH_TOOL_ID)
  );
  let allowedToolNames = run.compiledAccessScope.tools.filter((tool) => (
    !workflowRemoteAliases.has(tool)
    && !workspaceNativeToolIds.has(tool)
    && !providerNativeToolIds.has(tool)
  ));
  let allowedToolOperations = Object.fromEntries(allowedToolNames.map((tool) => [
    tool,
    run.compiledAccessScope.toolOperations[tool] === 'write' ? 'write' as const : 'read' as const
  ]));
  let allowedToolRefs: Array<{ serverId: string; toolName: string }> = workflowMcpTools.map((tool) => ({
    serverId: tool.serverId,
    toolName: tool.toolName
  }));
  const agentClaims = workflowRunAgentClaims(run);
  const allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [
    ...providerNativeToolIds
  ].map((id) => ({ id, config: {} }));
  const platformFunctions = workspaceNativeToolDefinitions.map((tool) => ({
    id: tool.id,
    model_alias: tool.modelAlias
  }));
  let allowedToolSpecs: Array<{
    name: string;
    server_id?: string;
    tool_name?: string;
    description: string;
    capability: 'read' | 'write';
    input_schema: Record<string, unknown>;
  }> = allowedToolNames.map((toolName) => ({
      name: toolName,
      description: `Execute workflow-granted tool "${toolName}".`,
      capability: allowedToolOperations[toolName] === 'read' ? 'read' as const : 'write' as const,
      input_schema: { type: 'object' }
    }));
  for (const tool of workspaceNativeToolDefinitions) {
    allowedToolNames.push(tool.modelAlias);
    allowedToolOperations[tool.modelAlias] = tool.approvalOperation;
    allowedToolSpecs.push({
      name: tool.modelAlias,
      description: tool.description,
      capability: tool.approvalOperation,
      input_schema: tool.inputSchema
    });
  }

  if ((run.targetId && !run.targetType) || (!run.targetId && run.targetType)) {
    res.status(409).json({ error: { code: 'WORKFLOW_TARGET_INVALID', message: 'Workflow run target binding is incomplete', retryable: false } });
    return;
  }
  if (run.targetType && !isTargetType(run.targetType)) {
    res.status(409).json({ error: { code: 'WORKFLOW_TARGET_TYPE_INVALID', message: 'Workflow run target type is not supported', retryable: false } });
    return;
  }
  const targetScoped = Boolean(run.targetId && run.targetType);
  if (targetScoped) {
    const targetTools = await resolveTargetRunTools({
      workspaceId: run.workspaceId,
      targetId: run.targetId!,
      targetType: run.targetType as 'kubernetes' | 'virtual_machine',
      toolAccessMode: run.compiledAccessScope.mode,
      runId: run.id,
      includeNativeTools: false
    });
    const effectiveTargetTools = intersectGrantedTargetRunTools(
      targetTools,
      run.compiledAccessScope.tools,
      run.compiledAccessScope.targetToolRefs || []
    );
    allowedToolNames = effectiveTargetTools.allowedToolNames;
    allowedToolOperations = effectiveTargetTools.allowedToolOperations;
    allowedToolSpecs = effectiveTargetTools.allowedToolSpecs
      .map((spec) => ({
        ...spec,
        capability: allowedToolOperations[spec.name] === 'write' ? 'write' as const : 'read' as const
      }));
    allowedToolRefs = [...effectiveTargetTools.allowedToolRefs, ...allowedToolRefs];
    for (const tool of workspaceNativeToolDefinitions) {
      allowedToolNames.push(tool.modelAlias);
      allowedToolOperations[tool.modelAlias] = tool.approvalOperation;
      allowedToolSpecs.push({
        name: tool.modelAlias,
        description: tool.description,
        capability: tool.approvalOperation,
        input_schema: tool.inputSchema
      });
    }
  }
  for (const tool of workflowMcpTools) {
    allowedToolNames.push(tool.alias);
    allowedToolOperations[tool.alias] = tool.capability === 'write' ? 'write' : 'read';
    allowedToolSpecs.push({
      name: tool.alias,
      server_id: tool.serverId,
      tool_name: tool.toolName,
      description: tool.description || `Execute reviewed MCP tool "${tool.toolName}".`,
      capability: tool.capability,
      input_schema: tool.inputSchema || { type: 'object' }
    });
  }
  const coordinationFunctions = workflowAgentSnapshot?.kind === 'manager'
    ? run.compiledAccessScope.coordinationFunctions
    : [];
  for (const name of coordinationFunctions) {
    allowedToolNames.push(name);
    allowedToolOperations[name] = 'read';
    allowedToolSpecs.push(name === '_acornops_delegate_specialist'
      ? {
          name,
          description: 'Delegate one capability-scoped task on one pinned target. The control plane selects the least-privileged eligible specialist.',
          capability: 'read' as const,
          input_schema: {
            type: 'object',
            required: ['capabilityId', 'targetBinding', 'taskPrompt'],
            properties: {
              capabilityId: { type: 'string' },
              targetBinding: {
                type: 'object', required: ['id', 'targetType'],
                properties: { id: { type: 'string' }, targetType: { type: 'string', enum: ['kubernetes', 'virtual_machine'] } },
                additionalProperties: false
              },
              taskPrompt: { type: 'string' },
              required: { type: 'boolean', default: true }
            },
            additionalProperties: false
          }
        }
      : {
          name,
          description: 'Read the current results and failures of this Manager run’s persisted delegations.',
          capability: 'read' as const,
          input_schema: { type: 'object', additionalProperties: false }
        });
  }
  allowedToolNames = [...new Set(allowedToolNames)];

  const workflowPrincipal = run.compiledAccessScope.principal || { type: 'user' as const, id: session.createdBy };
  const commonTokenClaims = {
    runId: run.id,
    workspaceId: run.workspaceId,
    sessionId: run.workflowSessionId,
    ...(workflowPrincipal.type === 'user' ? { userId: workflowPrincipal.id } : {}),
    principal: workflowPrincipal,
    permissionMode: run.compiledAccessScope.permissionMode || (run.compiledAccessScope.mode === 'read_only' ? 'read_only' : 'ask_before_changes'),
    allowedProviders,
    allowedTools: allowedToolNames,
    allowedToolRefs,
    allowedNativeTools,
    allowedToolOperations,
    contextGrants: run.compiledAccessScope.contextGrants,
    maxOutputTokens,
    allowedModels,
    allowedRepository: run.compiledAccessScope.exactRepository,
    agentId: agentClaims.agentId,
    agentVersion: agentClaims.agentVersion
  };
  const token = targetScoped
    ? await gatewayTokenService.signRunScopeToken({
        ...commonTokenClaims,
        scopeType: 'target',
        targetId: run.targetId!,
        targetType: run.targetType as 'kubernetes' | 'virtual_machine'
      })
    : await gatewayTokenService.signRunScopeToken({
        ...commonTokenClaims,
        scopeType: 'workspace',
        workflowId: run.workflowId,
        workflowRunId: run.workflowRunId,
        workflowSessionId: run.workflowSessionId,
        agentId: agentClaims.agentId,
        agentVersion: agentClaims.agentVersion,
        triggerId: agentClaims.triggerId
      });

  const snapshot = {
    contract_version: 2,
    scope: {
      type: targetScoped ? 'target' : 'workspace',
      workspace_id: run.workspaceId,
      session_id: run.workflowSessionId,
      run_id: run.id,
      ...(targetScoped ? { target_id: run.targetId, target_type: run.targetType } : {}),
      user_id: session.createdBy,
      workflow_id: run.workflowId,
      workflow_run_id: run.workflowRunId,
      workflow_execution_id: run.executionId,
      workflow_session_id: run.workflowSessionId,
      attempt_number: run.attemptNumber,
      idempotency_key: run.idempotencyKey,
      ...(agentClaims.agentId ? { agent_id: agentClaims.agentId } : {}),
      ...(agentClaims.agentVersion ? { agent_version: agentClaims.agentVersion } : {}),
      ...(agentClaims.triggerId ? { trigger_id: agentClaims.triggerId } : {})
    },
    assistant: {
      instructions: workflowAgentSnapshot?.instructions || ''
    },
    policy: {
      max_runtime_ms: config.ASSISTANT_MAX_RUNTIME_MS,
      max_output_tokens: maxOutputTokens ?? null,
      budget_cents: config.ASSISTANT_BUDGET_CENTS,
      max_steps: config.ASSISTANT_MAX_STEPS,
      max_tool_calls: config.ASSISTANT_MAX_TOOL_CALLS,
      max_duplicate_tool_calls: config.ASSISTANT_MAX_DUPLICATE_TOOL_CALLS
    },
    context: {
      endpoint: `/internal/v1/workflow-sessions/${run.workflowSessionId}/context`,
      max_context_tokens: config.ASSISTANT_CONTEXT_MAX_TOKENS
    },
    llm: {
      provider: llmSettings.provider,
      model: llmSettings.model,
      temperature: config.ASSISTANT_LLM_TEMPERATURE,
      mode: 'gateway',
      reasoning: llmSettings.reasoning,
      gateway: {
        url: config.LLM_GATEWAY_URL,
        token,
        request_timeout_ms: config.LLM_GATEWAY_TIMEOUT_MS
      }
    },
    tools: {
      tool_registry_version: 'trv_1',
      allowed_tools: allowedToolNames,
      allowed_tool_refs: allowedToolRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
      native_tools: allowedNativeTools,
      platform_functions: platformFunctions,
      tool_specs: allowedToolSpecs,
      write_unavailable_reason: null,
      confirmation_required_for_write: Object.values(allowedToolOperations).includes('write'),
      approval_timeout_seconds: config.ASSISTANT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
      gateway: {
        url: config.LLM_GATEWAY_URL,
        token
      }
    },
    routing: {
      target_scoped: targetScoped,
      workflow_scoped: true
    },
    tracing: {
      trace_id: randomUUID(),
      sample_rate: 0.1
    }
  };

  res.status(200).json(snapshot);
}

export async function bootstrap(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const workflowRun = await getWorkflowRun(runId);
    if (workflowRun) {
      await bootstrapWorkflowRun(workflowRun, res);
      return;
    }
    const agentRun = await getAgentActivityRecord(runId);
    if (agentRun) {
      await bootstrapAgentRun(agentRun, res);
      return;
    }
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    const target = await repo.getTarget(run.workspaceId, run.targetId);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target not found for run', retryable: false } });
      return;
    }
    const targetId = target.id;
    const session = await repo.getSession(run.sessionId);
    const targetSkills = await repo.getRunSkillCatalog(run.id);

    const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId, {
      provider: run.llmProvider,
      model: run.llmModel,
      reasoningSummaryMode: run.llmReasoningSummaryMode,
      reasoningEffort: run.llmReasoningEffort
    });
    const allowedProviders = llmSettings.allowedProviders;
    const allowedModels = llmSettings.allowedModels;
    if (!allowedProviders.includes(llmSettings.provider)) {
      res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Workspace AI provider is not enabled', retryable: false } });
      return;
    }
    if (!allowedModels.includes(llmSettings.model)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not allowed', retryable: false } });
      return;
    }
    if (!isModelAllowedForProvider(llmSettings.provider, llmSettings.model, llmSettings.allowedProviderModels)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not available for the selected provider', retryable: false } });
      return;
    }
    if (!llmSettings.credentialConfigured) {
      res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Workspace AI provider credential is not configured', retryable: false } });
      return;
    }
    const maxOutputTokens = config.LLM_MAX_OUTPUT_TOKENS;
    if (!run.principal) {
      res.status(409).json({ error: { code: 'RUN_PRINCIPAL_MISSING', message: 'This run does not have a pinned principal.', retryable: false } });
      return;
    }
    const permissionMode = run.toolAccessMode === 'read_only' ? 'read_only' as const : 'ask_before_changes' as const;
    const toolResolution = await resolveTargetRunTools({
      workspaceId: run.workspaceId,
      targetId,
      targetType: target.targetType,
      toolAccessMode: run.toolAccessMode,
      runId: run.id
    });
    const allowedToolSpecs = toolResolution.allowedToolSpecs;
    const allowedToolNames = toolResolution.allowedToolNames;
    const allowedToolRefs = toolResolution.allowedToolRefs;
    const allowedNativeTools = toolResolution.allowedNativeTools;
    const platformFunctions = toolResolution.platformFunctions.map((tool) => ({
      id: tool.id,
      model_alias: tool.modelAlias
    }));
    const allowedToolOperations = toolResolution.allowedToolOperations;
    const referencedTools = (run.assistantReferences || []).filter((reference) => reference.kind === 'tool');
    const referencedSkills = (run.assistantReferences || []).filter((reference) => reference.kind === 'skill');
    const currentToolPreviews = new Map(toolResolution.previewItems.map((tool) => [tool.name, tool]));
    const staleToolReference = referencedTools.find((reference) => {
      const current = currentToolPreviews.get(reference.id);
      if (!current) return true;
      if (!reference.serverId && !reference.toolName) return false;
      return !allowedToolSpecs.some((tool) => tool.name === reference.id
        && tool.server_id === reference.serverId
        && tool.tool_name === reference.toolName);
    });
    const skillRefById = new Map(targetSkills.map((skill) => [skill.skillId, skill.ref]));
    const staleSkillReference = referencedSkills.find((reference) => !skillRefById.has(reference.id));
    if (staleToolReference || staleSkillReference) {
      res.status(409).json({
        error: {
          code: 'ASSISTANT_REFERENCE_INVALID',
          message: 'A referenced tool or skill is no longer available for this run.',
          retryable: false
        }
      });
      return;
    }

    const token = await gatewayTokenService.signRunScopeToken({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId,
      targetType: target.targetType,
      sessionId: run.sessionId,
      ...(run.principal.type === 'user' ? { userId: run.principal.id } : {}),
      principal: run.principal,
      permissionMode,
      allowedProviders,
      allowedTools: allowedToolNames,
      allowedToolRefs,
      allowedNativeTools,
      allowedToolOperations,
      maxOutputTokens,
      allowedModels
    });

    const snapshot = {
      contract_version: 2,
      scope: {
        workspace_id: run.workspaceId,
        target_id: targetId,
        target_type: target.targetType,
        session_id: run.sessionId,
        run_id: run.id,
        user_id: run.principal.type === 'user' ? run.principal.id : undefined
      },
      assistant: targetAssistantContract(target.targetType),
      policy: {
        max_runtime_ms: config.ASSISTANT_MAX_RUNTIME_MS,
        max_output_tokens: maxOutputTokens ?? null,
        budget_cents: config.ASSISTANT_BUDGET_CENTS,
        max_steps: config.ASSISTANT_MAX_STEPS,
        max_tool_calls: config.ASSISTANT_MAX_TOOL_CALLS,
        max_duplicate_tool_calls: config.ASSISTANT_MAX_DUPLICATE_TOOL_CALLS
      },
      context: {
        endpoint: `/internal/v1/sessions/${run.sessionId}/context`,
        max_context_tokens: config.ASSISTANT_CONTEXT_MAX_TOKENS
      },
      llm: {
        provider: llmSettings.provider,
        model: llmSettings.model,
        temperature: config.ASSISTANT_LLM_TEMPERATURE,
        mode: 'gateway',
        reasoning: llmSettings.reasoning,
        gateway: {
          url: config.LLM_GATEWAY_URL,
          token,
          request_timeout_ms: config.LLM_GATEWAY_TIMEOUT_MS
        }
      },
      tools: {
        tool_registry_version: 'trv_1',
        allowed_tools: allowedToolNames,
        allowed_tool_refs: allowedToolRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
        native_tools: allowedNativeTools,
        platform_functions: platformFunctions,
        tool_specs: allowedToolSpecs,
        referenced_tools: referencedTools.map((reference) => ({
          name: reference.id,
          label: reference.label,
          ...(reference.serverId ? { server_id: reference.serverId } : {}),
          ...(reference.toolName ? { tool_name: reference.toolName } : {})
        })),
        write_unavailable_reason: toolResolution.writeUnavailableReason,
        confirmation_required_for_write: Object.values(allowedToolOperations).includes('write'),
        approval_timeout_seconds: toolResolution.approvalTimeoutSeconds,
        gateway: {
          url: config.LLM_GATEWAY_URL,
          token
        }
      },
      ...(targetSkills.length > 0 ? {
        skills: {
          contract_version: 2,
          entries: targetSkills.map((skill) => ({
            ref: skill.ref,
            skill_id: skill.skillId,
            name: skill.name,
            description: skill.description,
            file_count: skill.fileCount,
            total_bytes: skill.totalBytes,
            source: 'target_adapter'
          })),
          referenced_refs: referencedSkills.map((reference) => skillRefById.get(reference.id)!),
          load_endpoint: `/internal/v1/runs/${run.id}/skills/{skill_ref}`
        }
      } : {}),
      routing: {
        target_scoped: true
      },
      tracing: {
        trace_id: randomUUID(),
        sample_rate: 0.1
      }
    };

    res.status(200).json(snapshot);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
