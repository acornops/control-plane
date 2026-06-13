import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { agentGateway } from '../agent/ws-server.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { incrementRunEventsIngested } from '../metrics.js';
import { listTargetMcpTools, LlmGatewayHttpError, McpToolConfig } from '../services/mcp-registry-client.js';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import { syncTargetBuiltInTools } from '../services/target-built-in-tool-sync.js';
import { resolveWorkspaceLlmSettings } from '../services/workspace-ai-resolution.js';
import { publishRunEvents } from '../services/control-plane-coordination.js';
import { sanitizeToolInputSchema, sanitizeToolText } from '../services/tool-metadata.js';
import { gatewayTokenService } from '../services/token-service.js';
import { emitRunStatusTransition } from '../services/webhooks.js';
import { repo } from '../store/repository.js';
import { runtime } from '../store/runtime.js';
import { KUBERNETES_TARGET_TYPE, RunEvent, TargetType } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';
import { mapGatewayError } from './workspaces/common.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to check workspace AI provider settings with llm-gateway';
const RUN_EVENT_METRIC_TYPE_OTHER = 'other';
const RUN_EVENT_METRIC_TYPES = new Set([
  'run_progress',
  'run_started',
  'assistant_message_started',
  'assistant_token_delta',
  'assistant_reasoning_summary_delta',
  'assistant_reasoning_summary_completed',
  'assistant_reasoning_summary_unavailable',
  'tool_call_started',
  'tool_call_completed',
  'tool_approval_requested',
  'tool_approval_approved',
  'tool_approval_rejected',
  'tool_approval_expired',
  'assistant_message_completed',
  'run_failed',
  'run_cancelled',
  'run_completed'
]);

export function normalizeToolCapability(tool: Pick<McpToolConfig, 'capability'>): 'read' | 'write' {
  return tool.capability === 'read' ? 'read' : 'write';
}

function buildTerminalFailureMessage(status: string, errorMessage?: string): string {
  if (status === 'cancelled') {
    return 'I could not complete the troubleshooting run.\n\nThe run was cancelled.';
  }
  const detail = String(errorMessage || '').trim();
  return `I could not complete the troubleshooting run.\n\n${detail || 'No additional details were provided.'}`;
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function acceptsExecutionRunEvent(status: string, event: RunEvent): boolean {
  if (isTerminalRunStatus(status)) {
    return false;
  }
  if (status === 'cancelling') {
    return event.type === 'run_cancelled';
  }
  return true;
}

export function summarizeRunEventCounts(events: RunEvent[]): Map<string, number> {
  const eventCounts = new Map<string, number>();
  for (const event of events) {
    const eventType = RUN_EVENT_METRIC_TYPES.has(event.type) ? event.type : RUN_EVENT_METRIC_TYPE_OTHER;
    eventCounts.set(eventType, (eventCounts.get(eventType) || 0) + 1);
  }
  return eventCounts;
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

  await syncTargetBuiltInTools(workspaceId, targetId, targetType);
  try {
    const tools = await listTargetMcpTools(workspaceId, targetId, targetType);
    if (tools.length > 0) {
      return tools;
    }
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Failed listing target tools after resync');
  }

  try {
    const agentTools = await agentGateway.listAgentTools(targetId);
    if (agentTools.length === 0) {
      return [];
    }
    logger.warn(
      { workspaceId, targetId, targetType, runId, toolCount: agentTools.length },
      'Using agent-advertised tool fallback for run bootstrap'
    );
    return agentTools.map((tool) => ({
      name: tool.name,
      mcp_server_url: config.BUILTIN_MCP_SERVER_URL,
      timeout_ms: tool.timeout_ms ?? config.AGENT_TOOL_DEFAULT_TIMEOUT_MS,
      description: tool.description,
      capability: tool.capability === 'read' ? 'read' : 'write',
      version: typeof tool.version === 'string' && tool.version.trim().length > 0 ? tool.version : 'v1',
      source: 'builtin',
      input_schema:
        tool.input_schema && typeof tool.input_schema === 'object'
          ? (tool.input_schema as Record<string, unknown>)
          : { type: 'object', additionalProperties: true },
      enabled: true
    }));
  } catch (err) {
    logger.warn({ workspaceId, targetId, targetType, runId, err }, 'Agent fallback tool resolution failed');
    return [];
  }
}

async function resolveWriteConfirmationRequired(targetType: TargetType, targetId: string): Promise<boolean> {
  if (targetType === KUBERNETES_TARGET_TYPE) {
    return (await repo.getCluster(targetId))?.writeConfirmationPolicy.effectiveRequired ?? config.AGENT_WRITE_CONFIRMATION_REQUIRED;
  }
  return config.AGENT_WRITE_CONFIRMATION_REQUIRED;
}

export async function bootstrap(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
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
    if (!isModelAllowedForProvider(llmSettings.provider, llmSettings.model, allowedModels)) {
      res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Workspace AI model is not available for the selected provider', retryable: false } });
      return;
    }
    if (!llmSettings.credentialConfigured) {
      res.status(400).json({ error: { code: 'AI_PROVIDER_CREDENTIAL_MISSING', message: 'Workspace AI provider credential is not configured', retryable: false } });
      return;
    }
    const maxOutputTokens = config.LLM_MAX_OUTPUT_TOKENS;
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
        tool_specs: allowedToolSpecs,
        confirmation_required_for_write: runAllowsWrite
          ? await resolveWriteConfirmationRequired(target.targetType, targetId)
          : false,
        approval_timeout_seconds: config.AGENT_WRITE_CONFIRMATION_TIMEOUT_SECONDS,
        gateway: {
          url: config.LLM_GATEWAY_URL,
          token
        }
      },
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

export async function getSessionContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = toSingleParam(req.params.sessionId);
    const runId = String(req.query.run_id || '');
    const session = await repo.getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found', retryable: false } });
      return;
    }

    if (runId) {
      const run = await repo.getRun(runId);
      if (!run || run.sessionId !== sessionId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found for session', retryable: false } });
        return;
      }
    }

    const messagesPage = await repo.listMessages(sessionId);
    const context = {
      messages: [
        {
          role: 'system',
          content: config.AGENT_SYSTEM_INSTRUCTION
        },
        ...messagesPage.items.map((message) => ({ role: message.role, content: message.content }))
      ],
      summaries: [],
      attachments: []
    };

    res.status(200).json(context);
  } catch (err) {
    next(err);
  }
}

export async function ingestRunEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    let currentRun = run;
    const incomingEvents = Array.isArray(req.body.events) ? req.body.events as RunEvent[] : [];
    const acceptedEvents: RunEvent[] = [];
    let filterStatus = currentRun.status;
    for (const event of incomingEvents) {
      if (!acceptsExecutionRunEvent(filterStatus, event)) {
        continue;
      }
      acceptedEvents.push(event);
      if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
        filterStatus = event.type === 'run_completed'
          ? 'completed'
          : event.type === 'run_failed'
            ? 'failed'
            : 'cancelled';
      }
    }
    if (acceptedEvents.length === 0) {
      res.status(200).json({ status: 'ok', accepted: 0 });
      return;
    }
    const accepted = await repo.appendRunEvents(run.id, acceptedEvents);
    const buffered = runtime.appendRunEvents(run.id, accepted);
    const bufferedEventCounts = summarizeRunEventCounts(buffered);
    for (const [eventType, count] of bufferedEventCounts.entries()) {
      incrementRunEventsIngested(eventType, count);
    }
    logger.info(
      {
        runId: run.id,
        workspaceId: run.workspaceId,
        accepted: buffered.length,
        eventTypes: Object.fromEntries(bufferedEventCounts)
      },
      'Accepted execution run events'
    );
    for (const event of buffered) {
      if (isTerminalRunStatus(currentRun.status)) {
        runtime.runStreams.emit(`run:${run.id}`, { event });
        continue;
      }
      if (event.type === 'run_started') {
        const updatedRun = await repo.updateRun(run.id, { status: 'running', startedAt: currentRun.startedAt || new Date().toISOString() });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'tool_approval_requested') {
        const updatedRun = await repo.updateRun(run.id, { status: 'waiting_for_approval' });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'run_failed') {
        const updatedRun = await repo.updateRun(run.id, {
          status: 'failed',
          errorCode: String((event.payload.code as string | undefined) || 'RUN_FAILED'),
          errorMessage: String((event.payload.message as string | undefined) || 'Run failed'),
          endedAt: new Date().toISOString()
        });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      } else if (event.type === 'run_cancelled') {
        const updatedRun = await repo.updateRun(run.id, { status: 'cancelled', endedAt: new Date().toISOString() });
        emitRunStatusTransition(currentRun, updatedRun);
        currentRun = updatedRun || currentRun;
      }
      runtime.runStreams.emit(`run:${run.id}`, { event });
    }
    publishRunEvents(run.id, buffered).catch((err) => {
      logger.warn({ err, runId: run.id }, 'Failed publishing distributed run events');
    });

    res.status(200).json({ status: 'ok', accepted: buffered.length });
  } catch (err) {
    next(err);
  }
}

export async function getRunEventCursor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }

    const latestSeq = config.PERSIST_RUN_EVENTS
      ? await repo.getLatestRunEventSeq(run.id)
      : Math.max(0, ...runtime.getRunEvents(run.id).map((event) => event.seq));
    res.status(200).json({ latestSeq });
  } catch (err) {
    next(err);
  }
}

export async function commitRun(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found', retryable: false } });
      return;
    }
    if (isTerminalRunStatus(run.status)) {
      res.status(200).json({ status: 'ok', terminal: true });
      return;
    }

    const assistantMessage = req.body.status === 'cancelled'
      ? { ...req.body.assistant_message, content: '' }
      : req.body.assistant_message;

    const updatedRun = await repo.updateRun(run.id, {
      status: req.body.status,
      startedAt: req.body.timing.started_at,
      endedAt: req.body.timing.ended_at,
      usage: req.body.usage,
      assistantMessage
    });
    emitRunStatusTransition(run, updatedRun);

    const committedContent = String(assistantMessage?.content || '').trim();
    if (committedContent) {
      await repo.upsertAssistantFinalMessage(run.sessionId, run.id, committedContent);
    } else if (req.body.status === 'failed' || req.body.status === 'cancelled') {
      const failureMessage = buildTerminalFailureMessage(req.body.status, updatedRun?.errorMessage || run.errorMessage);
      await repo.upsertAssistantFinalMessage(run.sessionId, run.id, failureMessage);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
}

export async function getRunCommit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const runId = toSingleParam(req.params.runId);
    const run = await repo.getRun(runId);
    if (!run || !run.endedAt) {
      res.status(200).json({});
      return;
    }

    res.status(200).json({
      status: run.status,
      assistant_message: run.assistantMessage,
      usage: run.usage,
      timing: {
        started_at: run.startedAt,
        ended_at: run.endedAt
      }
    });
  } catch (err) {
    next(err);
  }
}
