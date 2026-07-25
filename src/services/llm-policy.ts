import {
  configuredProviders,
  flatProviderModels,
  parseConfigCsv,
  parseConfiguredProvidersJson,
  parseConfiguredReasoningEfforts,
  parseConfiguredReasoningSummaryModes,
  type ProviderModelMap,
  SUPPORTED_LLM_PROVIDER_VALUES
} from '../config-llm-policy.js';
import { LlmProvider, ReasoningEffort, ReasoningSummaryMode } from '../types/domain.js';
import { effectiveAiPlatformPolicy } from './platform-settings.js';

export const SUPPORTED_LLM_PROVIDERS: LlmProvider[] = [...SUPPORTED_LLM_PROVIDER_VALUES];

export function isSupportedLlmProvider(provider: string): provider is LlmProvider {
  return SUPPORTED_LLM_PROVIDERS.includes(provider as LlmProvider);
}

export function parseCsv(value: string): string[] {
  return parseConfigCsv(value);
}

export function parseAllowedProviders(value?: string): LlmProvider[] {
  return configuredProviders(value
    ? parseConfiguredProvidersJson(value)
    : effectiveAiPlatformPolicy().providerModels);
}

export function parseAllowedProviderModels(
  value?: string
): ProviderModelMap {
  return value
    ? parseConfiguredProvidersJson(value)
    : effectiveAiPlatformPolicy().providerModels;
}

export function parseAllowedModels(
  value?: string
): string[] {
  return flatProviderModels(value
    ? parseConfiguredProvidersJson(value)
    : effectiveAiPlatformPolicy().providerModels);
}

export function parseAllowedReasoningSummaryModes(
  value?: string
): ReasoningSummaryMode[] {
  return value
    ? parseConfiguredReasoningSummaryModes(value)
    : effectiveAiPlatformPolicy().reasoningSummaryModes;
}

export function parseAllowedReasoningEfforts(
  value?: string
): ReasoningEffort[] {
  return value
    ? parseConfiguredReasoningEfforts(value)
    : effectiveAiPlatformPolicy().reasoningEfforts;
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
  return effectiveAiPlatformPolicy().defaultProvider;
}

export function defaultModel(): string {
  return effectiveAiPlatformPolicy().defaultModel;
}

export function reasoningSummariesEnabled(): boolean {
  return effectiveAiPlatformPolicy().reasoningSummariesEnabled;
}
