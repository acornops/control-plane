import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { WEB_SEARCH_TOOL_ID } from '../services/provider-native-tool-ids.js';
import { gatewayTokenService } from '../services/token-service.js';
import { workflowRunAgentClaims } from '../services/workflow-run-agent-claims.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, getWorkflowSession, WorkflowRunRecord } from '../store/repository-workflows.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';
import { getWorkspaceNativeTool } from '../services/workspace-native-tools.js';
import { bootstrapAgentChatRun } from './internal-agent-chat-bootstrap.js';
import { bootstrapTargetRun } from './internal-target-run-bootstrap.js';
import { resolveRunSkillSnapshots } from '../services/run-skill-snapshots.js';

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
  const workflowAgentSnapshot = run.executorSnapshot.role === 'specialist'
    ? run.executorSnapshot.agent
    : undefined;
  const workflowSkills = workflowAgentSnapshot
    ? resolveRunSkillSnapshots(workflowAgentSnapshot, run.compiledAccessScope.enabledSkills)
    : [];
  const workflowMcpTools = (workflowAgentSnapshot?.mcpInstallations || []).flatMap((installation) => {
    if (!installation.enabled) return [];
    return installation.tools.filter((tool) => tool.enabled && tool.reviewState === 'approved'
      && workflowMcpRefKeys.has(`${tool.serverId}\u0000${tool.toolName}`));
  });
  const workflowRemoteAliases = new Set(workflowMcpTools.map((tool) => tool.alias));
  const workspaceNativeToolDefinitions = (run.parentRunId ? [] : run.compiledAccessScope.tools)
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
  const coordinationFunctions = run.executorRole === 'coordinator'
    ? run.compiledAccessScope.coordinationFunctions
    : [];
  for (const name of coordinationFunctions) {
    allowedToolNames.push(name);
    allowedToolOperations[name] = 'read';
    allowedToolSpecs.push(name === '_acornops_delegate_specialist'
      ? {
          name,
          description: 'Delegate one capability-scoped task. The control plane selects the least-privileged eligible specialist.',
          capability: 'read' as const,
          input_schema: {
            type: 'object',
            required: ['capabilityId', 'taskPrompt'],
            properties: {
              capabilityId: { type: 'string' },
              taskPrompt: { type: 'string' },
              required: { type: 'boolean', default: true }
            },
            additionalProperties: false
          }
        }
      : {
          name,
          description: 'Read the current results and failures of this coordinator run’s specialist children.',
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
    maxOutputTokens,
    allowedModels,
    resourceBindings: run.compiledAccessScope.resourceBindings,
    bindingDigest: run.compiledAccessScope.bindingDigest
  };
  const token = await gatewayTokenService.signRunScopeToken({
    ...commonTokenClaims,
    scopeType: 'workspace',
    workflowId: run.workflowId,
    executionId: run.executionId,
    workflowSessionId: run.workflowSessionId,
    executorRole: run.executorRole,
    agentId: agentClaims.agentId,
    triggerId: agentClaims.triggerId
  });

  const snapshot = {
    contract_version: 2,
    scope: {
      type: 'workspace',
      workspace_id: run.workspaceId,
      session_id: run.workflowSessionId,
      run_id: run.id,
      user_id: session.createdBy,
      workflow_id: run.workflowId,
      execution_id: run.executionId,
      executor_role: run.executorRole,
      ...(run.parentRunId ? { parent_run_id: run.parentRunId } : {}),
      workflow_session_id: run.workflowSessionId,
      attempt_number: run.attemptNumber,
      idempotency_key: run.idempotencyKey,
      ...(agentClaims.agentId ? { agent_id: agentClaims.agentId } : {}),
      ...(agentClaims.triggerId ? { trigger_id: agentClaims.triggerId } : {})
    },
    assistant: {
      instructions: run.executorSnapshot.role === 'coordinator'
        ? run.executorSnapshot.instructions
        : workflowAgentSnapshot?.instructions || ''
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
      endpoint: `/internal/v1/runs/${run.id}/context`,
      max_context_tokens: config.ASSISTANT_CONTEXT_MAX_TOKENS
    },
    resources: {
      prompt_digest: run.promptDigest,
      binding_digest: run.bindingDigest,
      resolved_at: run.resolvedAt,
      bindings: run.resourceBindings.map((binding) => ({
        binding_id: binding.bindingId,
        type: binding.type,
        resource_id: binding.resourceId,
        provider: binding.provider,
        provider_version: binding.providerVersion,
        workspace_id: binding.workspaceId,
        label_snapshot: binding.labelSnapshot,
        source: binding.source,
        operations: binding.operations,
        context_mode: binding.contextMode,
        ...(binding.providerData ? { provider_data: binding.providerData } : {})
      }))
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
    ...(workflowSkills.length > 0 ? {
      skills: {
        contract_version: 2,
        entries: workflowSkills.map(({ ref, installation, totalBytes }) => ({
          ref,
          skill_id: installation.id,
          name: installation.name,
          description: installation.description,
          file_count: installation.files.length,
          total_bytes: totalBytes,
          source: 'agent'
        })),
        referenced_refs: [],
        load_endpoint: `/internal/v1/runs/${run.id}/skills/{skill_ref}`
      }
    } : {}),
    routing: { workflow_scoped: true },
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
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (run.conversationKind === 'agent_chat') {
      await bootstrapAgentChatRun(run, res);
      return;
    }
    await bootstrapTargetRun(run, res);
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
