import { z } from 'zod';

export const SUPPORTED_LLM_PROVIDER_VALUES = ['openai', 'anthropic', 'gemini'] as const;

interface LlmPolicyConfig {
  LLM_DEFAULT_PROVIDER: typeof SUPPORTED_LLM_PROVIDER_VALUES[number];
  LLM_DEFAULT_MODEL: string;
  LLM_ALLOWED_PROVIDERS: string;
  LLM_ALLOWED_MODELS: string;
}

function addConfigIssue(ctx: z.RefinementCtx, field: string, message: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message
  });
}

export function parseConfigCsv(value: string): string[] {
  const parsed: string[] = [];
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    if (!parsed.includes(entry)) {
      parsed.push(entry);
    }
  }
  return parsed;
}

export function parseConfiguredAllowedProviders(value: string): Array<typeof SUPPORTED_LLM_PROVIDER_VALUES[number]> {
  const providers: Array<typeof SUPPORTED_LLM_PROVIDER_VALUES[number]> = [];
  for (const entry of parseConfigCsv(value).map((item) => item.toLowerCase())) {
    if (
      SUPPORTED_LLM_PROVIDER_VALUES.includes(entry as typeof SUPPORTED_LLM_PROVIDER_VALUES[number]) &&
      !providers.includes(entry as typeof SUPPORTED_LLM_PROVIDER_VALUES[number])
    ) {
      providers.push(entry as typeof SUPPORTED_LLM_PROVIDER_VALUES[number]);
    }
  }
  return providers;
}

export function configuredModelBelongsToProvider(
  model: string,
  provider: typeof SUPPORTED_LLM_PROVIDER_VALUES[number]
): boolean {
  const normalized = model.toLowerCase();
  if (provider === 'openai') {
    return normalized.startsWith('gpt-') || normalized.startsWith('o');
  }
  if (provider === 'anthropic') {
    return normalized.includes('claude');
  }
  return normalized.includes('gemini');
}

export function configuredAllowedModelsForProvider(
  provider: typeof SUPPORTED_LLM_PROVIDER_VALUES[number],
  models: string[]
): string[] {
  const providerModels = models.filter((model) => configuredModelBelongsToProvider(model, provider));
  return providerModels.length > 0 ? providerModels : models;
}

export function validateLlmPolicyConfig(ctx: z.RefinementCtx, value: LlmPolicyConfig): void {
  const allowedProviders = parseConfiguredAllowedProviders(value.LLM_ALLOWED_PROVIDERS);
  if (allowedProviders.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_PROVIDERS', 'LLM_ALLOWED_PROVIDERS must include at least one supported provider');
  }
  if (!allowedProviders.includes(value.LLM_DEFAULT_PROVIDER)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_PROVIDER', 'LLM_DEFAULT_PROVIDER must be included in LLM_ALLOWED_PROVIDERS');
  }

  const allowedModels = parseConfigCsv(value.LLM_ALLOWED_MODELS);
  if (allowedModels.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_MODELS', 'LLM_ALLOWED_MODELS must include at least one model');
    return;
  }
  if (!allowedModels.includes(value.LLM_DEFAULT_MODEL)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_MODEL', 'LLM_DEFAULT_MODEL must be included in LLM_ALLOWED_MODELS');
    return;
  }
  if (!configuredAllowedModelsForProvider(value.LLM_DEFAULT_PROVIDER, allowedModels).includes(value.LLM_DEFAULT_MODEL)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_MODEL', 'LLM_DEFAULT_MODEL must be available for LLM_DEFAULT_PROVIDER');
  }
}
