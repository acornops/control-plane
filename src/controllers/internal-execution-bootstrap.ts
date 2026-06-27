import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listTargetMcpTools, LlmGatewayHttpError, McpToolConfig } from '../services/mcp-registry-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { syncTargetBuiltInTools } from '../services/target-built-in-tool-sync.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { sanitizeToolInputSchema, sanitizeToolText } from '../services/tool-metadata.js';
import { gatewayTokenService } from '../services/token-service.js';
import { repo } from '../store/repository.js';
import { getWorkflowRun, getWorkflowSession, WorkflowRunRecord } from '../store/repository-workflows.js';
import { KUBERNETES_TARGET_TYPE, TargetType } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';
const WEB_SEARCH_TOOL_ID = 'web_search';

export function normalizeToolCapability(tool: Pick<McpToolConfig, 'capability'>): 'read' | 'write' {
  return tool.capability === 'read' ? 'read' : 'write';
}

async function resolveTargetToolsForRun(workspaceId: string, targetId: string, targetType: TargetType, runId: string): Promise<McpToolConfig[]> {
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools; attempting resync');
  }

  const syncResult = await syncTargetBuiltInTools(workspaceId, targetId, targetType);
  if (!syncResult.ok || syncResult.registeredToolCount === 0) {
    logger.warn(
      {
        workspaceId,
        targetId,
        targetType,
        runId,
        ok: syncResult.ok,
        discoveredToolCount: syncResult.discoveredToolCount,
        registeredToolCount: syncResult.registeredToolCount,
        error: syncResult.error
      },
      'Run bootstrap built-in tool sync did not register target tools'
    );
  }
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools after resync');
  }

  logger.warn(
    { workspaceId, targetId, targetType, runId },
    'No gateway-registered target tools available for run bootstrap'
  );
  return [];
}

async function resolveWriteConfirmationRequired(targetType: TargetType, targetId: string): Promise<boolean> {
  if (targetType === KUBERNETES_TARGET_TYPE) {
    return (await repo.getCluster(targetId))?.writeConfirmationPolicy.effectiveRequired ?? config.AGENT_WRITE_CONFIRMATION_REQUIRED;
  }
  return config.AGENT_WRITE_CONFIRMATION_REQUIRED;
}

async function bootstrapWorkflowRun(run: WorkflowRunRecord, res: Response): Promise<void> {
  const session = getWorkflowSession(run.workflowSessionId);
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
  const allowedToolOperations = run.compiledAccessScope.toolOperations;
  const allowedToolNames = run.compiledAccessScope.tools;
  const allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [];
  const allowedToolSpecs = allowedToolNames.map((toolName) => ({
    name: toolName,
    description: `Execute workflow-granted tool "${toolName}".`,
    capability: allowedToolOperations[toolName] === 'read' ? 'read' as const : 'write' as const,
    input_schema: { type: 'object' }
  }));

  const token = await gatewayTokenService.signRunScopeToken({
    scopeType: 'workspace',
    runId: run.id,
    workspaceId: run.workspaceId,
    sessionId: run.workflowSessionId,
    workflowId: run.workflowId,
    workflowRunId: run.workflowRunId,
    workflowSessionId: run.workflowSessionId,
    workflowStepId: run.workflowStepId,
    allowedProviders,
    allowedTools: allowedToolNames,
    allowedNativeTools,
    allowedToolOperations,
    contextGrants: run.compiledAccessScope.contextGrants,
    maxOutputTokens,
    allowedModels
  });

  const snapshot = {
    contract_version: 1,
    scope: {
      type: 'workspace',
      workspace_id: run.workspaceId,
      session_id: run.workflowSessionId,
      run_id: run.id,
      user_id: session.createdBy,
      workflow_id: run.workflowId,
      workflow_run_id: run.workflowRunId,
      workflow_session_id: run.workflowSessionId,
      ...(run.workflowStepId ? { workflow_step_id: run.workflowStepId } : {})
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
      confirmation_required_for_write: run.compiledAccessScope.approvalGates.length > 0,
      approval_timeout_seconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
      gateway: {
        url: config.LLM_GATEWAY_URL,
        token
      }
    },
    routing: {
      target_scoped: false,
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
    const workflowRun = getWorkflowRun(runId);
    if (workflowRun) {
      await bootstrapWorkflowRun(workflowRun, res);
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
    const agentRegistration = await repo.getTargetAgentRegistration(targetId);
    const targetSupportsWrite = Boolean(agentRegistration?.capabilities?.includes('write'));
    const runAllowsWrite = run.toolAccessMode === 'read_write';

    let allowedToolNames: string[] = [];
    let allowedToolSpecs: Array<{ name: string; description: string; input_schema: Record<string, unknown>; capability: 'read' | 'write' }> = [];
    let hasConfiguredWriteTool = false;
    const targetSkills = await repo.listEnabledValidTargetSkills(targetId);
    try {
      const [tools, overrides] = await Promise.all([
        resolveTargetToolsForRun(run.workspaceId, targetId, target.targetType, run.id),
        repo.listTargetToolOverrides(targetId)
      ]);
      const enabledTools = tools
        .filter((tool) => {
          const effectiveEnabled = Object.prototype.hasOwnProperty.call(overrides, tool.name)
            ? overrides[tool.name]
            : tool.enabled;
          if (!effectiveEnabled) return false;
          const capability = normalizeToolCapability(tool);
          if (capability === 'write') hasConfiguredWriteTool = true;
          if (capability === 'write' && !targetSupportsWrite) return false;
          if (capability === 'write' && !runAllowsWrite) return false;
          return true;
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      allowedToolNames = [...new Set(enabledTools.map((tool) => tool.name))];
      allowedToolSpecs = enabledTools.map((tool) => ({
        name: tool.name,
        description:
          sanitizeToolText(tool.description)
          || `Execute tool "${tool.name}" for target diagnostics.`,
        capability: normalizeToolCapability(tool),
        input_schema: sanitizeToolInputSchema(tool.input_schema)
      }));
    } catch (err) {
      logger.warn(
        {
          runId: run.id,
          workspaceId: run.workspaceId,
          targetId,
          targetType: target.targetType,
          err
        },
        'Failed resolving run tool catalog; continuing with no tool permissions'
      );
      allowedToolNames = [];
    }

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
    let allowedNativeTools: Array<{ id: string; config: Record<string, unknown> }> = [];
    try {
      allowedNativeTools = (await repo.listEnabledTargetToolSettings(targetId))
        .filter((tool) => tool.toolId === WEB_SEARCH_TOOL_ID)
        .map((tool) => ({
          id: tool.toolId,
          config: tool.config
        }));
    } catch (err) {
      logger.warn(
        {
          runId: run.id,
          workspaceId: run.workspaceId,
          targetId,
          targetType: target.targetType,
          err
        },
        'Failed resolving run native tools; continuing with no native tool permissions'
      );
    }
    const allowedToolOperations = Object.fromEntries(
      allowedToolSpecs.map((tool) => [tool.name, tool.capability])
    );

    const token = await gatewayTokenService.signRunScopeToken({
      runId: run.id,
      workspaceId: run.workspaceId,
      targetId,
      targetType: target.targetType,
      sessionId: run.sessionId,
      allowedProviders,
      allowedTools: allowedToolNames,
      allowedNativeTools,
      allowedToolOperations,
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
        allowed_tools: allowedToolNames,
        native_tools: allowedNativeTools,
        tool_specs: allowedToolSpecs,
        write_unavailable_reason: hasConfiguredWriteTool
          ? !runAllowsWrite
            ? 'run_read_only'
            : !targetSupportsWrite
              ? 'agent_write_disabled'
              : null
          : null,
        confirmation_required_for_write: runAllowsWrite
          ? await resolveWriteConfirmationRequired(target.targetType, targetId)
          : false,
        approval_timeout_seconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
        gateway: {
          url: config.LLM_GATEWAY_URL,
          token
        }
      },
      ...(targetSkills.length > 0 ? {
        skills: {
          registry_version: 'sv_1',
          entries: targetSkills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            files: skill.files
              .slice()
              .sort((left, right) => left.path.localeCompare(right.path))
              .map((file) => ({
                path: file.path,
                content: file.content
              }))
          }))
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
