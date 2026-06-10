import { config } from '../config.js';
import {
  configuredAllowedModelsForProvider,
  configuredModelBelongsToProvider,
  parseConfigCsv,
  parseConfiguredAllowedProviders,
  SUPPORTED_LLM_PROVIDER_VALUES
} from '../config-llm-policy.js';
import { LlmProvider } from '../types/domain.js';

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

export function parseAllowedModels(value = config.LLM_ALLOWED_MODELS): string[] {
  return parseConfigCsv(value);
}

export function modelBelongsToProvider(model: string, provider: LlmProvider): boolean {
  return configuredModelBelongsToProvider(model, provider);
}

export function allowedModelsForProvider(provider: LlmProvider, models = parseAllowedModels()): string[] {
  return configuredAllowedModelsForProvider(provider, models);
}

export function isModelAllowedForProvider(provider: LlmProvider, model: string, models = parseAllowedModels()): boolean {
  return allowedModelsForProvider(provider, models).includes(model);
}

export function defaultProvider(): LlmProvider {
  return config.LLM_DEFAULT_PROVIDER;
}

export function defaultModel(): string {
  return config.LLM_DEFAULT_MODEL;
}
