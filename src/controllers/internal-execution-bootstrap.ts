import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { LlmGatewayHttpError } from '../services/mcp-registry-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { resolveTargetRunTools } from '../services/target-run-tool-resolution.js';
import { gatewayTokenService } from '../services/token-service.js';
import { workflowRunAgentClaims } from '../services/workflow-run-agent-claims.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, getWorkflowSession, WorkflowRunRecord } from '../store/repository-workflows.js';
import { getAgentActivityRecord } from '../store/repository-agents.js';
import type { AgentActivityRecord } from '../types/agents.js';
import { isTargetType } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';

async function bootstrapAgentRun(run: AgentActivityRecord, res: Response): Promise<void> {
  const llmSettings = await resolveWorkspaceLlmSettings(run.workspaceId);
  if (!llmSettings.credentialConfigured) {
    res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Workspace AI provider credential is not configured', retryable: false } });
    return;
  }
  let allowedTools = run.compiledScope.tools;
  let allowedToolOperations = run.compiledScope.toolOperations;
  let allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [];
  let toolSpecs: Array<{ name: string; description: string; capability: 'read'|'write'; input_schema: Record<string, unknown> }> =
    allowedTools.map((name) => ({ name, description: `Execute Agent-granted tool "${name}".`, capability: allowedToolOperations[name] === 'write' ? 'write' : 'read', input_schema: { type: 'object' } }));
  if (run.targetId && run.targetType) {
    const targetTools = await resolveTargetRunTools({
      workspaceId: run.workspaceId, targetId: run.targetId, targetType: run.targetType,
      toolAccessMode: 'read_only', runId: run.id
    });
    const granted = new Set(run.compiledScope.tools);
    allowedTools = targetTools.allowedToolNames.filter((name) => granted.has(name));
    allowedToolOperations = Object.fromEntries(allowedTools.map((name) => [name, 'read' as const]));
    allowedNativeTools = targetTools.allowedNativeTools;
    toolSpecs = targetTools.allowedToolSpecs.filter((spec) => granted.has(spec.name));
  }
  const token = await gatewayTokenService.signRunScopeToken({
    scopeType: 'workspace', runId: run.id, workspaceId: run.workspaceId, sessionId: run.id,
    agentId: run.agentId, agentVersion: run.agentVersion, triggerId: run.triggerId,
    targetId: run.targetId, targetType: run.targetType,
    allowedProviders: llmSettings.allowedProviders, allowedTools, allowedNativeTools,
    allowedToolOperations, contextGrants: run.compiledScope.contextGrants,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS, allowedModels: llmSettings.allowedModels
  });
  const agentApprovalPolicy = run.agentSnapshot?.approvalPolicy;
  const confirmationRequiredForWrite = Object.values(allowedToolOperations).includes('write') && (
    agentApprovalPolicy?.mode === 'always' ||
    agentApprovalPolicy?.mode === 'before_write' ||
    agentApprovalPolicy?.writeToolsRequireApproval !== false
  );
  res.status(200).json({
    contract_version: 1,
    scope: { type: 'workspace', workspace_id: run.workspaceId, session_id: run.id, run_id: run.id,
      agent_id: run.agentId, agent_version: run.agentVersion, trigger_id: run.triggerId,
      target_id: run.targetId, target_type: run.targetType },
    agent: { id: run.agentId, version: run.agentVersion },
    policy: { max_runtime_ms: config.AGENT_MAX_RUNTIME_MS, max_output_tokens: config.LLM_MAX_OUTPUT_TOKENS ?? null,
      budget_cents: config.AGENT_BUDGET_CENTS, max_steps: config.AGENT_MAX_STEPS,
      max_tool_calls: config.AGENT_MAX_TOOL_CALLS, max_duplicate_tool_calls: config.AGENT_MAX_DUPLICATE_TOOL_CALLS },
    context: { endpoint: `/internal/v1/agent-runs/${run.id}/context`, max_context_tokens: config.AGENT_CONTEXT_MAX_TOKENS },
    llm: { provider: llmSettings.provider, model: llmSettings.model, temperature: config.AGENT_LLM_TEMPERATURE,
      mode: 'gateway', reasoning: llmSettings.reasoning,
      gateway: { url: config.LLM_GATEWAY_URL, token, request_timeout_ms: config.LLM_GATEWAY_TIMEOUT_MS } },
    tools: { tool_registry_version: 'trv_1', allowed_tools: allowedTools, native_tools: allowedNativeTools,
      tool_specs: toolSpecs, write_unavailable_reason: null,
      confirmation_required_for_write: confirmationRequiredForWrite,
      approval_timeout_seconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
      gateway: { url: config.LLM_GATEWAY_URL, token } },
    routing: { target_scoped: Boolean(run.targetId), workflow_scoped: false },
    tracing: { trace_id: randomUUID(), sample_rate: 0.1 }
  });
}

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
  let allowedToolOperations = run.compiledAccessScope.toolOperations;
  let allowedToolNames = run.compiledAccessScope.tools;
  const agentClaims = workflowRunAgentClaims(run);
  const allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [];
  let allowedToolSpecs: Array<{
    name: string;
    description: string;
    capability: 'read' | 'write';
    input_schema: Record<string, unknown>;
  }> = allowedToolNames.map((toolName) => ({
    name: toolName,
    description: `Execute workflow-granted tool "${toolName}".`,
    capability: allowedToolOperations[toolName] === 'read' ? 'read' as const : 'write' as const,
    input_schema: { type: 'object' }
  }));

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
      builtInOnly: true,
      includeNativeTools: false
    });
    const granted = new Set(run.compiledAccessScope.tools);
    allowedToolNames = targetTools.allowedToolNames.filter((name) => granted.has(name));
    allowedToolOperations = Object.fromEntries(allowedToolNames.map((name) => [
      name,
      run.compiledAccessScope.toolOperations[name] === 'write' ? 'write' as const : 'read' as const
    ]));
    allowedToolSpecs = targetTools.allowedToolSpecs
      .filter((spec) => granted.has(spec.name))
      .map((spec) => ({
        ...spec,
        capability: allowedToolOperations[spec.name] === 'write' ? 'write' as const : 'read' as const
      }));
  }

  const commonTokenClaims = {
    runId: run.id,
    workspaceId: run.workspaceId,
    sessionId: run.workflowSessionId,
    allowedProviders,
    allowedTools: allowedToolNames,
    allowedNativeTools,
    allowedToolOperations,
    contextGrants: run.compiledAccessScope.contextGrants,
    maxOutputTokens,
    allowedModels
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
        workflowStepId: run.workflowStepId,
        agentId: agentClaims.agentId,
        agentVersion: agentClaims.agentVersion,
        triggerId: agentClaims.triggerId
      });

  const snapshot = {
    contract_version: 1,
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
      step_index: run.stepIndex,
      attempt_number: run.attemptNumber,
      idempotency_key: run.idempotencyKey,
      ...(run.workflowStepId ? { workflow_step_id: run.workflowStepId } : {}),
      ...(agentClaims.agentId ? { agent_id: agentClaims.agentId } : {}),
      ...(agentClaims.agentVersion ? { agent_version: agentClaims.agentVersion } : {}),
      ...(agentClaims.triggerId ? { trigger_id: agentClaims.triggerId } : {})
    },
    policy: {
      max_runtime_ms: config.AGENT_MAX_RUNTIME_MS,
      max_output_tokens: maxOutputTokens ?? null,
      budget_cents: config.AGENT_BUDGET_CENTS,
      max_steps: config.AGENT_MAX_STEPS,
      max_tool_calls: config.AGENT_MAX_TOOL_CALLS,
      max_duplicate_tool_calls: config.AGENT_MAX_DUPLICATE_TOOL_CALLS
    },
    context: {
      endpoint: `/internal/v1/workflow-sessions/${run.workflowSessionId}/context`,
      max_context_tokens: config.AGENT_CONTEXT_MAX_TOKENS
    },
    llm: {
      provider: llmSettings.provider,
      model: llmSettings.model,
      temperature: config.AGENT_LLM_TEMPERATURE,
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
      native_tools: allowedNativeTools,
      tool_specs: allowedToolSpecs,
      write_unavailable_reason: null,
      confirmation_required_for_write: Object.values(allowedToolOperations).includes('write'),
      approval_timeout_seconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
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
    const toolResolution = await resolveTargetRunTools({
      workspaceId: run.workspaceId,
      targetId,
      targetType: target.targetType,
      toolAccessMode: run.toolAccessMode,
      runId: run.id
    });

    const token = await gatewayTokenService.signRunScopeToken({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId,
      targetType: target.targetType,
      sessionId: run.sessionId,
      allowedProviders,
      allowedTools: toolResolution.allowedToolNames,
      allowedNativeTools: toolResolution.allowedNativeTools,
      allowedToolOperations: toolResolution.allowedToolOperations,
      maxOutputTokens,
      allowedModels
    });

    const snapshot = {
      contract_version: 1,
      scope: {
        workspace_id: run.workspaceId,
        target_id: targetId,
        target_type: target.targetType,
        session_id: run.sessionId,
        run_id: run.id,
        user_id: session?.createdBy || randomUUID()
      },
      policy: {
        max_runtime_ms: config.AGENT_MAX_RUNTIME_MS,
        max_output_tokens: maxOutputTokens ?? null,
        budget_cents: config.AGENT_BUDGET_CENTS,
        max_steps: config.AGENT_MAX_STEPS,
        max_tool_calls: config.AGENT_MAX_TOOL_CALLS,
        max_duplicate_tool_calls: config.AGENT_MAX_DUPLICATE_TOOL_CALLS
      },
      context: {
        endpoint: `/internal/v1/sessions/${run.sessionId}/context`,
        max_context_tokens: config.AGENT_CONTEXT_MAX_TOKENS
      },
      llm: {
        provider: llmSettings.provider,
        model: llmSettings.model,
        temperature: config.AGENT_LLM_TEMPERATURE,
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
        allowed_tools: toolResolution.allowedToolNames,
        native_tools: toolResolution.allowedNativeTools,
        tool_specs: toolResolution.allowedToolSpecs,
        write_unavailable_reason: toolResolution.writeUnavailableReason,
        confirmation_required_for_write: toolResolution.confirmationRequiredForWrite,
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
            total_bytes: skill.totalBytes
          })),
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
