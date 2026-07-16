import { z } from 'zod';

export const SUPPORTED_LLM_PROVIDER_VALUES = ['openai', 'anthropic', 'gemini'] as const;
export const REASONING_SUMMARY_MODE_VALUES = ['off', 'auto', 'concise', 'detailed'] as const;
export const REASONING_EFFORT_VALUES = ['off', 'low', 'medium', 'high'] as const;
export const DEFAULT_REASONING_EFFORT = 'low' as const;
export const DEFAULT_LLM_ALLOWED_PROVIDER_MODELS = [
  'openai:gpt-5.5|gpt-5.4|gpt-5.4-mini|gpt-5.4-nano|gpt-5|gpt-5-mini|gpt-5-nano',
  'anthropic:claude-fable-5|claude-opus-4-8|claude-sonnet-4-6|claude-haiku-4-5',
  'gemini:gemini-3.5-flash|gemini-3.5-flash-lite|gemini-3.1-pro|gemini-3.1-flash|gemini-3.1-flash-lite|gemini-2.5-pro|gemini-2.5-flash|gemini-2.5-flash-lite|gemini-2.0-flash|gemini-2.0-flash-lite'
].join(';');

interface LlmPolicyConfig {
  LLM_DEFAULT_PROVIDER: typeof SUPPORTED_LLM_PROVIDER_VALUES[number];
  LLM_DEFAULT_MODEL: string;
  LLM_ALLOWED_PROVIDERS: string;
  LLM_ALLOWED_PROVIDER_MODELS: string;
  LLM_ALLOWED_REASONING_SUMMARY_MODES: string;
  LLM_ALLOWED_REASONING_EFFORTS: string;
}

export type ProviderModelMap = Record<typeof SUPPORTED_LLM_PROVIDER_VALUES[number], string[]>;

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

export function emptyProviderModelMap(): ProviderModelMap {
  return {
    openai: [],
    anthropic: [],
    gemini: []
  };
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

export function parseConfiguredAllowedProviderModels(value: string): ProviderModelMap {
  const providerModels = emptyProviderModelMap();
  for (const entry of value.split(';').map((item) => item.trim()).filter(Boolean)) {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) continue;
    const provider = entry.slice(0, separatorIndex).trim().toLowerCase();
    if (!SUPPORTED_LLM_PROVIDER_VALUES.includes(provider as typeof SUPPORTED_LLM_PROVIDER_VALUES[number])) {
      continue;
    }
    const models = entry
      .slice(separatorIndex + 1)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    const target = providerModels[provider as typeof SUPPORTED_LLM_PROVIDER_VALUES[number]];
    for (const model of models) {
      if (!target.includes(model)) {
        target.push(model);
      }
    }
  }
  return providerModels;
}

export function flatProviderModels(providerModels: ProviderModelMap): string[] {
  const models: string[] = [];
  for (const provider of SUPPORTED_LLM_PROVIDER_VALUES) {
    for (const model of providerModels[provider]) {
      if (!models.includes(model)) {
        models.push(model);
      }
    }
  }
  return models;
}

function parseAllowedEnumValues<T extends readonly string[]>(value: string, allowedValues: T): Array<T[number]> {
  const parsed: Array<T[number]> = [];
  for (const entry of parseConfigCsv(value).map((item) => item.toLowerCase())) {
    if (allowedValues.includes(entry as T[number]) && !parsed.includes(entry as T[number])) {
      parsed.push(entry as T[number]);
    }
  }
  return parsed;
}

export function parseConfiguredReasoningSummaryModes(value: string): Array<typeof REASONING_SUMMARY_MODE_VALUES[number]> {
  return parseAllowedEnumValues(value, REASONING_SUMMARY_MODE_VALUES);
}

export function parseConfiguredReasoningEfforts(value: string): Array<typeof REASONING_EFFORT_VALUES[number]> {
  return parseAllowedEnumValues(value, REASONING_EFFORT_VALUES);
}

export function validateLlmPolicyConfig(ctx: z.RefinementCtx, value: LlmPolicyConfig): void {
  const allowedProviders = parseConfiguredAllowedProviders(value.LLM_ALLOWED_PROVIDERS);
  if (allowedProviders.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_PROVIDERS', 'LLM_ALLOWED_PROVIDERS must include at least one supported provider');
  }
  if (!allowedProviders.includes(value.LLM_DEFAULT_PROVIDER)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_PROVIDER', 'LLM_DEFAULT_PROVIDER must be included in LLM_ALLOWED_PROVIDERS');
  }

  const providerModelMap = parseConfiguredAllowedProviderModels(value.LLM_ALLOWED_PROVIDER_MODELS);
  const allowedModels = flatProviderModels(providerModelMap);
  if (allowedModels.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_PROVIDER_MODELS', 'LLM policy must include at least one model');
    return;
  }
  for (const provider of allowedProviders) {
    if (providerModelMap[provider].length === 0) {
      addConfigIssue(ctx, 'LLM_ALLOWED_PROVIDER_MODELS', `LLM_ALLOWED_PROVIDER_MODELS must include at least one model for ${provider}`);
    }
  }
  if (!allowedModels.includes(value.LLM_DEFAULT_MODEL)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_MODEL', 'LLM_DEFAULT_MODEL must be included in the allowed LLM models');
    return;
  }
  const defaultProviderModels = providerModelMap[value.LLM_DEFAULT_PROVIDER];
  if (!defaultProviderModels.includes(value.LLM_DEFAULT_MODEL)) {
    addConfigIssue(ctx, 'LLM_DEFAULT_MODEL', 'LLM_DEFAULT_MODEL must be available for LLM_DEFAULT_PROVIDER');
  }

  const reasoningModes = parseConfiguredReasoningSummaryModes(value.LLM_ALLOWED_REASONING_SUMMARY_MODES);
  if (reasoningModes.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_REASONING_SUMMARY_MODES', 'LLM_ALLOWED_REASONING_SUMMARY_MODES must include at least one supported mode');
  }
  if (!reasoningModes.includes('off')) {
    addConfigIssue(ctx, 'LLM_ALLOWED_REASONING_SUMMARY_MODES', 'LLM_ALLOWED_REASONING_SUMMARY_MODES must include off');
  }

  const reasoningEfforts = parseConfiguredReasoningEfforts(value.LLM_ALLOWED_REASONING_EFFORTS);
  if (reasoningEfforts.length === 0) {
    addConfigIssue(ctx, 'LLM_ALLOWED_REASONING_EFFORTS', 'LLM_ALLOWED_REASONING_EFFORTS must include at least one supported effort');
  }
  if (!reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)) {
    addConfigIssue(ctx, 'LLM_ALLOWED_REASONING_EFFORTS', `LLM_ALLOWED_REASONING_EFFORTS must include ${DEFAULT_REASONING_EFFORT}`);
  }
}
