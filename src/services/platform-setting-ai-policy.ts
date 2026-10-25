import { z } from 'zod';
import { config } from '../config.js';
import {
  configuredProviders,
  DEFAULT_REASONING_EFFORT,
  flatProviderModels,
  parseConfiguredProvidersJson,
  parseConfiguredReasoningEfforts,
  parseConfiguredReasoningSummaryModes,
  REASONING_EFFORT_VALUES,
  REASONING_SUMMARY_MODE_VALUES,
  SUPPORTED_LLM_PROVIDER_VALUES
} from '../config-llm-policy.js';
import type { PlatformSettingOverride } from '../store/repository-platform-settings.js';
import type { AiPlatformPolicy, PlatformSettingState } from './platform-setting-types.js';

const providerModelsValueSchema = z.object({
  openai: z.array(z.string().trim().min(1)),
  anthropic: z.array(z.string().trim().min(1)),
  gemini: z.array(z.string().trim().min(1))
}).strict();

const additionalModelsSchema = z.array(
  z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/)
).max(100).refine((models) => new Set(models).size === models.length, 'Model IDs must be unique');

const additionalProviderModelsSchema = z.object({
  openai: additionalModelsSchema,
  anthropic: additionalModelsSchema,
  gemini: additionalModelsSchema
}).strict();

export const aiPolicyValueSchema = z.object({
  defaultProvider: z.enum(SUPPORTED_LLM_PROVIDER_VALUES),
  defaultModel: z.string().trim().min(1),
  providerModels: providerModelsValueSchema,
  reasoningSummariesEnabled: z.boolean(),
  reasoningSummaryModes: z.array(z.enum(REASONING_SUMMARY_MODE_VALUES)).min(1),
  reasoningEfforts: z.array(z.enum(REASONING_EFFORT_VALUES)).min(1),
  additionalProviderModels: additionalProviderModelsSchema.optional()
}).strict();

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function deploymentAiPolicy(): AiPlatformPolicy {
  return {
    defaultProvider: config.LLM_DEFAULT_PROVIDER,
    defaultModel: config.LLM_DEFAULT_MODEL,
    providerModels: parseConfiguredProvidersJson(config.LLM_PROVIDERS_JSON),
    reasoningSummariesEnabled: config.LLM_REASONING_SUMMARIES_ENABLED,
    reasoningSummaryModes: parseConfiguredReasoningSummaryModes(config.LLM_ALLOWED_REASONING_SUMMARY_MODES),
    reasoningEfforts: parseConfiguredReasoningEfforts(config.LLM_ALLOWED_REASONING_EFFORTS)
  };
}

function aiPolicyModelCatalog(override: AiPlatformPolicy, ceiling: AiPlatformPolicy): AiPlatformPolicy['providerModels'] {
  return Object.fromEntries(SUPPORTED_LLM_PROVIDER_VALUES.map((provider) => {
    const deployed = ceiling.providerModels[provider];
    const additional = config.PLATFORM_SETTINGS_POLICY.aiPolicy.allowAdditionalModels && deployed.length
      ? override.additionalProviderModels?.[provider] || []
      : [];
    return [provider, unique([...deployed, ...additional])];
  })) as AiPlatformPolicy['providerModels'];
}

function constrainedAiPolicy(override: AiPlatformPolicy, ceiling: AiPlatformPolicy): AiPlatformPolicy {
  const catalog = aiPolicyModelCatalog(override, ceiling);
  const definitions = override.additionalProviderModels
    ? { additionalProviderModels: override.additionalProviderModels }
    : {};
  const providerModels = {
    openai: unique(override.providerModels.openai.filter((model) => catalog.openai.includes(model))),
    anthropic: unique(override.providerModels.anthropic.filter((model) => catalog.anthropic.includes(model))),
    gemini: unique(override.providerModels.gemini.filter((model) => catalog.gemini.includes(model)))
  };
  // Losing the last permitted model must not reset an administrator's policy.
  // Keep the unavailable default identifiable until an explicit policy repair.
  const providers = configuredProviders(providerModels);
  const defaultProvider = providers.includes(override.defaultProvider)
    ? override.defaultProvider
    : providers.includes(ceiling.defaultProvider)
      ? ceiling.defaultProvider
      : providers[0] ?? override.defaultProvider;
  const defaultModel = providerModels[defaultProvider].includes(override.defaultModel)
    ? override.defaultModel
    : providerModels[defaultProvider].includes(ceiling.defaultModel)
      ? ceiling.defaultModel
      : providerModels[defaultProvider][0] ?? override.defaultModel;
  const reasoningSummariesEnabled = ceiling.reasoningSummariesEnabled && override.reasoningSummariesEnabled;
  const reasoningSummaryModes = reasoningSummariesEnabled
    ? unique(override.reasoningSummaryModes.filter((mode) => ceiling.reasoningSummaryModes.includes(mode)))
    : ['off' as const];
  const reasoningEfforts = unique(override.reasoningEfforts.filter((effort) => ceiling.reasoningEfforts.includes(effort)));
  return {
    defaultProvider,
    defaultModel,
    providerModels,
    reasoningSummariesEnabled,
    reasoningSummaryModes: reasoningSummaryModes.length ? reasoningSummaryModes : ['off'],
    reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : [ceiling.reasoningEfforts[0] || DEFAULT_REASONING_EFFORT],
    ...definitions
  };
}

export function aiPolicyState(entry?: PlatformSettingOverride): PlatformSettingState<'ai_policy'> {
  const deploymentDefault = deploymentAiPolicy();
  const parsed = entry?.overrideValue === null || entry?.overrideValue === undefined
    ? undefined
    : aiPolicyValueSchema.safeParse(entry.overrideValue);
  const overrideValue = parsed?.success ? parsed.data : undefined;
  const value = overrideValue ? constrainedAiPolicy(overrideValue, deploymentDefault) : deploymentDefault;
  const constrained = Boolean(overrideValue && JSON.stringify(value) !== JSON.stringify(overrideValue));
  return {
    key: 'ai_policy',
    value,
    deploymentDefault,
    ...(overrideValue ? { overrideValue } : {}),
    source: overrideValue
      ? constrained
        ? 'runtime_override_constrained'
        : 'runtime_override'
      : 'deployment_default',
    version: entry?.version || 0,
    ...(entry?.updatedBy ? { updatedBy: entry.updatedBy } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    editable: config.PLATFORM_SETTINGS_POLICY.aiPolicy.runtimeEditable,
    constraints: {
      providerModels: aiPolicyModelCatalog(value, deploymentDefault),
      allowAdditionalModels: config.PLATFORM_SETTINGS_POLICY.aiPolicy.allowAdditionalModels,
      reasoningSummariesEnabled: deploymentDefault.reasoningSummariesEnabled,
      reasoningSummaryModes: deploymentDefault.reasoningSummaryModes,
      reasoningEfforts: deploymentDefault.reasoningEfforts
    },
    ...(constrained ? { warning: 'The stored AI policy was narrowed to the current deployment ceiling.' } : {})
  };
}

export function validateAiPolicyOverride(
  candidate: AiPlatformPolicy,
  stored?: AiPlatformPolicy['additionalProviderModels']
): string | null {
  if (flatProviderModels(candidate.providerModels).length === 0) {
    return 'AI policy must enable at least one model.';
  }
  const deployment = deploymentAiPolicy();
  for (const provider of SUPPORTED_LLM_PROVIDER_VALUES) {
    const added = (candidate.additionalProviderModels?.[provider] || [])
      .filter((model) => !stored?.[provider].includes(model));
    if (added.length && (!config.PLATFORM_SETTINGS_POLICY.aiPolicy.allowAdditionalModels || !deployment.providerModels[provider].length)) {
      return 'Additional models require deployment opt-in and a deployment-permitted provider.';
    }
    if (added.some((model) => deployment.providerModels[provider].includes(model))) {
      return 'This model is already provided by the deployment.';
    }
  }
  const constrained = constrainedAiPolicy(candidate, deployment);
  return JSON.stringify(candidate) === JSON.stringify(constrained)
    ? null
    : 'AI policy may narrow, but cannot expand, the deployment ceiling.';
}
