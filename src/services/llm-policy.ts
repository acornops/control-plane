import { config } from '../config.js';
import {
  flatProviderModels,
  parseConfigCsv,
  parseConfiguredAllowedProviderModels,
  parseConfiguredAllowedProviders,
  parseConfiguredReasoningEfforts,
  parseConfiguredReasoningSummaryModes,
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
  value = config.LLM_ALLOWED_PROVIDER_MODELS
): ProviderModelMap {
  return parseConfiguredAllowedProviderModels(value);
}

export function parseAllowedModels(
  value = config.LLM_ALLOWED_PROVIDER_MODELS
): string[] {
  return flatProviderModels(parseConfiguredAllowedProviderModels(value));
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

export function allowedModelsForProvider(
  provider: LlmProvider,
  models: ProviderModelMap = parseAllowedProviderModels()
): string[] {
  return models[provider] || [];
}

export function isModelAllowedForProvider(
  provider: LlmProvider,
  model: string,
  models: ProviderModelMap = parseAllowedProviderModels()
): boolean {
  return allowedModelsForProvider(provider, models).includes(model);
}

export function defaultProvider(): LlmProvider {
  return config.LLM_DEFAULT_PROVIDER;
}

export function defaultModel(): string {
  return config.LLM_DEFAULT_MODEL;
}
