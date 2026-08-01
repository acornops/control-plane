import type { Response } from 'express';
import { isModelAllowedForProvider } from '../services/llm-policy.js';
import type { WorkspaceLlmSettingsResolution } from '../services/workspace-ai-resolution.js';

export function rejectUnavailableInteractiveLlm(
  res: Response,
  settings: WorkspaceLlmSettingsResolution,
  options: { credentialMessage?: string } = {}
): boolean {
  if (!settings.allowedProviders.includes(settings.provider)) {
    res.status(400).json({ error: {
      code: 'PROVIDER_NOT_ALLOWED',
      message: 'Workspace AI provider is not enabled',
      retryable: false
    } });
    return true;
  }
  if (!settings.allowedModels.includes(settings.model)
    || !isModelAllowedForProvider(settings.provider, settings.model, settings.allowedProviderModels)) {
    res.status(400).json({ error: {
      code: 'MODEL_NOT_ALLOWED',
      message: 'Workspace AI model is not allowed',
      retryable: false
    } });
    return true;
  }
  if (!settings.credentialConfigured) {
    res.status(400).json({ error: {
      code: 'AI_PROVIDER_CREDENTIAL_MISSING',
      message: options.credentialMessage || 'Workspace AI provider credential is not configured',
      retryable: false
    } });
    return true;
  }
  return false;
}
