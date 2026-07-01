import { config } from '../config.js';
import {
  configuredAllowedModelsForProvider,
  configuredModelBelongsToProvider,
  emptyProviderModelMap,
  flatProviderModels,
  parseConfigCsv,
  parseConfiguredAllowedProviderModels,
  parseConfiguredAllowedProviders,
  parseConfiguredReasoningEfforts,
  parseConfiguredReasoningSummaryModes,
  providerModelsConfigured,
  type ProviderModelMap,
  SUPPORTED_LLM_PROVIDER_VALUES
} from '../config-llm-policy.js';
import { LlmProvider, ReasoningEffort, ReasoningSummaryMode } from '../types/domain.js';

export const SUPPORTED_LLM_PROVIDERS: LlmProvider[] = [...SUPPORTED_LLM_PROVIDER_VALUES];

export function isSupportedLlmProvider(provider: string): provider is LlmProvider {
  return SUPPORTED_LLM_PROVIDERS.includes(provider as LlmProvider);
}

export function parseCsv(value: string): string[] {
  return parseConfigCsv(value);
}

export function parseAllowedProviders(value = config.LLM_ALLOWED_PROVIDERS): LlmProvider[] {
  return parseConfiguredAllowedProviders(value);
}

export function parseAllowedProviderModels(
  value = config.LLM_ALLOWED_PROVIDER_MODELS,
  legacyModels = config.LLM_ALLOWED_MODELS
): ProviderModelMap {
  if (providerModelsConfigured(value)) {
    return parseConfiguredAllowedProviderModels(value);
  }
  const models = parseConfigCsv(legacyModels);
  const providerModels = emptyProviderModelMap();
  for (const provider of SUPPORTED_LLM_PROVIDER_VALUES) {
    providerModels[provider] = configuredAllowedModelsForProvider(provider, models);
  }
  return providerModels;
}

export function parseAllowedModels(
  value = config.LLM_ALLOWED_PROVIDER_MODELS,
  legacyModels = config.LLM_ALLOWED_MODELS
): string[] {
  if (providerModelsConfigured(value)) {
    return flatProviderModels(parseConfiguredAllowedProviderModels(value));
  }
  return parseConfigCsv(legacyModels);
}

export function parseAllowedReasoningSummaryModes(
  value = config.LLM_ALLOWED_REASONING_SUMMARY_MODES
): ReasoningSummaryMode[] {
  return parseConfiguredReasoningSummaryModes(value);
}

export function parseAllowedReasoningEfforts(
  value = config.LLM_ALLOWED_REASONING_EFFORTS
): ReasoningEffort[] {
  return parseConfiguredReasoningEfforts(value);
}

export function modelBelongsToProvider(model: string, provider: LlmProvider): boolean {
  return configuredModelBelongsToProvider(model, provider);
}

export function allowedModelsForProvider(
  provider: LlmProvider,
  models: string[] | ProviderModelMap = parseAllowedProviderModels()
): string[] {
  if (!Array.isArray(models)) {
    return models[provider] || [];
  }
  return configuredAllowedModelsForProvider(provider, models);
}

export function isModelAllowedForProvider(
  provider: LlmProvider,
  model: string,
  models: string[] | ProviderModelMap = parseAllowedProviderModels()
): boolean {
  return allowedModelsForProvider(provider, models).includes(model);
}

export function defaultProvider(): LlmProvider {
  return config.LLM_DEFAULT_PROVIDER;
}

export function defaultModel(): string {
  return config.LLM_DEFAULT_MODEL;
}
