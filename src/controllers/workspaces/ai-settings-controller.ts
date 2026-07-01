import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/middleware.js';
import { config } from '../../config.js';
import { DEFAULT_REASONING_EFFORT } from '../../config-llm-policy.js';
import {
  requireWorkspaceCapability,
  requireWorkspaceRead
} from '../../auth/workspace-authorization.js';
import {
  deleteWorkspaceProviderCredential,
  listWorkspaceProviderCredentials,
  putWorkspaceProviderCredential
} from '../../services/llm-provider-credential-client.js';
import {
  parseAllowedReasoningEfforts,
  parseAllowedReasoningSummaryModes,
  defaultModel,
  defaultProvider,
  isModelAllowedForProvider,
  isSupportedLlmProvider,
  parseAllowedModels,
  parseAllowedProviderModels,
  parseAllowedProviders,
  SUPPORTED_LLM_PROVIDERS
} from '../../services/llm-policy.js';
import { effectiveAllowedProviders } from '../../services/workspace-ai-resolution.js';
import { recordWorkspaceAuditEvent } from '../../services/workspace-audit.js';
import { repo } from '../../store/repository.js';
import { LlmProvider, ReasoningEffort, ReasoningSummaryMode, WorkspaceAiSettings } from '../../types/domain.js';
import { toSingleParam } from '../../utils/params.js';
import { LlmGatewayHttpError } from '../../services/mcp-registry-client.js';
import { mapGatewayError } from './common.js';
import { requeuePausedTargetInsightsCheckpoints } from '../../services/target-insights/requeue.js';

const AI_GATEWAY_UPSTREAM_MESSAGE = 'Failed to synchronize AI provider settings with llm-gateway';

function effectiveSettings(settings: WorkspaceAiSettings | null): WorkspaceAiSettings {
  return {
    workspaceId: settings?.workspaceId || '',
    defaultProvider: settings?.defaultProvider || defaultProvider(),
    defaultModel: settings?.defaultModel || defaultModel(),
    reasoningSummaryMode: settings?.reasoningSummaryMode || 'auto',
    reasoningEffort: settings?.reasoningEffort || DEFAULT_REASONING_EFFORT,
    createdAt: settings?.createdAt,
    updatedAt: settings?.updatedAt
  };
}

function defaultReasoningSummaryMode(existingMode?: ReasoningSummaryMode): ReasoningSummaryMode {
  const allowedModes = parseAllowedReasoningSummaryModes();
  if (!config.LLM_REASONING_SUMMARIES_ENABLED) {
    return 'off';
  }
  if (existingMode && allowedModes.includes(existingMode)) {
    return existingMode;
  }
  if (allowedModes.includes('auto')) {
    return 'auto';
  }
  return 'off';
}

function defaultReasoningEffort(existingEffort?: ReasoningEffort): ReasoningEffort {
  const allowedEfforts = parseAllowedReasoningEfforts();
  if (existingEffort && allowedEfforts.includes(existingEffort)) {
    return existingEffort;
  }
  return allowedEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : allowedEfforts[0] || DEFAULT_REASONING_EFFORT;
}

async function buildAiSettingsResponse(workspaceId: string) {
  const [settings, credentials] = await Promise.all([
    repo.getWorkspaceAiSettings(workspaceId),
    listWorkspaceProviderCredentials(workspaceId)
  ]);
  const resolved = effectiveSettings(settings);
  const allowedProviders = effectiveAllowedProviders(credentials.providers);
  const allowedProviderModels = parseAllowedProviderModels();
  const configuredReasoningSummaryModes = parseAllowedReasoningSummaryModes();
  const allowedReasoningSummaryModes = config.LLM_REASONING_SUMMARIES_ENABLED
    ? configuredReasoningSummaryModes
    : ['off' as const];
  const allowedReasoningEfforts = parseAllowedReasoningEfforts();
  const effectiveReasoningSummaryMode =
    config.LLM_REASONING_SUMMARIES_ENABLED && allowedReasoningSummaryModes.includes(resolved.reasoningSummaryMode)
      ? resolved.reasoningSummaryMode
      : 'off';
  return {
    workspaceId,
    defaultProvider: resolved.defaultProvider,
    defaultModel: resolved.defaultModel,
    reasoningSummaryMode: effectiveReasoningSummaryMode,
    reasoningEffort: allowedReasoningEfforts.includes(resolved.reasoningEffort)
      ? resolved.reasoningEffort
      : DEFAULT_REASONING_EFFORT,
    allowedReasoningSummaryModes,
    allowedReasoningEfforts,
    reasoningSummariesEnabled: config.LLM_REASONING_SUMMARIES_ENABLED && effectiveReasoningSummaryMode !== 'off',
    allowedProviders,
    allowedProviderModels,
    allowedModels: parseAllowedModels(),
    providers: credentials.providers.map((provider) => ({
      ...provider,
      enabled: provider.enabled && allowedProviders.includes(provider.provider)
    }))
  };
}

function validateProviderModel(res: Response, provider: LlmProvider, model: string): boolean {
  const allowedModels = parseAllowedModels();
  const allowedProviderModels = parseAllowedProviderModels();
  if (!parseAllowedProviders().includes(provider)) {
    res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Selected provider is not allowed by this deployment', retryable: false } });
    return false;
  }
  if (!allowedModels.includes(model)) {
    res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Selected model is not allowed by this deployment', retryable: false } });
    return false;
  }
  if (!isModelAllowedForProvider(provider, model, allowedProviderModels)) {
    res.status(400).json({ error: { code: 'MODEL_NOT_ALLOWED', message: 'Selected model is not available for the selected provider', retryable: false } });
    return false;
  }
  return true;
}

function validateReasoningSettings(
  res: Response,
  mode: ReasoningSummaryMode,
  effort: ReasoningEffort
): boolean {
  const allowedModes = parseAllowedReasoningSummaryModes();
  const allowedEfforts = parseAllowedReasoningEfforts();
  if (!allowedModes.includes(mode)) {
    res.status(400).json({ error: { code: 'REASONING_SUMMARY_MODE_NOT_ALLOWED', message: 'Selected reasoning summary mode is not allowed by this deployment', retryable: false } });
    return false;
  }
  if (!allowedEfforts.includes(effort)) {
    res.status(400).json({ error: { code: 'REASONING_EFFORT_NOT_ALLOWED', message: 'Selected reasoning effort is not allowed by this deployment', retryable: false } });
    return false;
  }
  if (!config.LLM_REASONING_SUMMARIES_ENABLED && mode !== 'off') {
    res.status(400).json({ error: { code: 'REASONING_SUMMARIES_DISABLED', message: 'Reasoning summaries are disabled by this deployment', retryable: false } });
    return false;
  }
  return true;
}

async function validateProviderEnabled(res: Response, workspaceId: string, provider: LlmProvider): Promise<boolean> {
  const credentials = await listWorkspaceProviderCredentials(workspaceId);
  if (!effectiveAllowedProviders(credentials.providers).includes(provider)) {
    res.status(400).json({ error: { code: 'PROVIDER_NOT_ALLOWED', message: 'Selected provider is not enabled by this deployment', retryable: false } });
    return false;
  }
  return true;
}

export async function cleanupWorkspaceAiProviderCredentials(workspaceId: string): Promise<void> {
  for (const provider of SUPPORTED_LLM_PROVIDERS) {
    await deleteWorkspaceProviderCredential(workspaceId, provider);
  }
}

export async function getWorkspaceAiSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (!(await requireWorkspaceRead(req, res, workspaceId))) {
      return;
    }
    res.status(200).json(await buildAiSettingsResponse(workspaceId));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function updateWorkspaceAiSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_ai_settings',
        'Only workspace admins and owners can manage AI assistant settings'
      ))
    ) {
      return;
    }
    if (!validateProviderModel(res, req.body.defaultProvider, req.body.defaultModel)) {
      return;
    }
    if (!(await validateProviderEnabled(res, workspaceId, req.body.defaultProvider))) {
      return;
    }
    const previous = await repo.getWorkspaceAiSettings(workspaceId);
    const reasoningSummaryMode = (
      req.body.reasoningSummaryMode || defaultReasoningSummaryMode(previous?.reasoningSummaryMode)
    ) as ReasoningSummaryMode;
    const reasoningEffort = (
      req.body.reasoningEffort || defaultReasoningEffort(previous?.reasoningEffort)
    ) as ReasoningEffort;
    if (!validateReasoningSettings(res, reasoningSummaryMode, reasoningEffort)) {
      return;
    }
    await repo.upsertWorkspaceAiSettings(workspaceId, {
      defaultProvider: req.body.defaultProvider,
      defaultModel: req.body.defaultModel,
      reasoningSummaryMode,
      reasoningEffort
    });
    await requeuePausedTargetInsightsCheckpoints({ workspaceId, reason: 'workspace_ai_settings_updated' });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'workspace',
      eventType: 'workspace.ai_settings.updated.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workspace',
      objectId: workspaceId,
      summary: 'Workspace AI assistant settings updated',
      metadata: {
        previousProvider: previous?.defaultProvider || null,
        previousModel: previous?.defaultModel || null,
        previousReasoningSummaryMode: previous?.reasoningSummaryMode || null,
        previousReasoningEffort: previous?.reasoningEffort || null,
        nextProvider: req.body.defaultProvider,
        nextModel: req.body.defaultModel,
        nextReasoningSummaryMode: reasoningSummaryMode,
        nextReasoningEffort: reasoningEffort
      }
    });
    res.status(200).json(await buildAiSettingsResponse(workspaceId));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function upsertWorkspaceAiProviderCredential(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const provider = toSingleParam(req.params.provider) as LlmProvider;
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_ai_settings',
        'Only workspace admins and owners can manage AI assistant settings'
      ))
    ) {
      return;
    }
    if (!isSupportedLlmProvider(provider)) {
      res.status(400).json({ error: { code: 'PROVIDER_NOT_SUPPORTED', message: 'Selected provider is not supported', retryable: false } });
      return;
    }
    if (!(await validateProviderEnabled(res, workspaceId, provider))) {
      return;
    }
    await putWorkspaceProviderCredential(workspaceId, provider, req.body.apiKey);
    await requeuePausedTargetInsightsCheckpoints({ workspaceId, reason: 'workspace_ai_provider_credential_saved' });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'workspace',
      eventType: 'workspace.ai_provider_credential.saved.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workspace',
      objectId: workspaceId,
      summary: 'Workspace AI provider credential saved',
      metadata: { provider }
    });
    res.status(200).json(await buildAiSettingsResponse(workspaceId));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}

export async function deleteWorkspaceAiProviderCredential(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const provider = toSingleParam(req.params.provider) as LlmProvider;
    if (
      !(await requireWorkspaceCapability(
        req,
        res,
        workspaceId,
        'manage_ai_settings',
        'Only workspace admins and owners can manage AI assistant settings'
      ))
    ) {
      return;
    }
    if (!isSupportedLlmProvider(provider)) {
      res.status(400).json({ error: { code: 'PROVIDER_NOT_SUPPORTED', message: 'Selected provider is not supported', retryable: false } });
      return;
    }
    await deleteWorkspaceProviderCredential(workspaceId, provider);
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'workspace',
      eventType: 'workspace.ai_provider_credential.deleted.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'workspace',
      objectId: workspaceId,
      summary: 'Workspace AI provider credential deleted',
      metadata: { provider }
    });
    res.status(200).json(await buildAiSettingsResponse(workspaceId));
  } catch (err) {
    if (err instanceof LlmGatewayHttpError) {
      const mapped = mapGatewayError(err, { upstreamMessage: AI_GATEWAY_UPSTREAM_MESSAGE });
      res.status(mapped.status).json(mapped.body);
      return;
    }
    next(err);
  }
}
