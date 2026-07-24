import { z } from 'zod';

export const SUPPORTED_LLM_PROVIDER_VALUES = ['openai', 'anthropic', 'gemini'] as const;
export const REASONING_SUMMARY_MODE_VALUES = ['off', 'auto', 'concise', 'detailed'] as const;
export const REASONING_EFFORT_VALUES = ['off', 'low', 'medium', 'high'] as const;
export const DEFAULT_REASONING_EFFORT = 'low' as const;

export type ProviderModelMap = Record<typeof SUPPORTED_LLM_PROVIDER_VALUES[number], string[]>;

export const DEFAULT_LLM_PROVIDERS: ProviderModelMap = {
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
  anthropic: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  gemini: [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro',
    'gemini-3.1-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
  ]
};
export const DEFAULT_LLM_PROVIDERS_JSON = JSON.stringify(DEFAULT_LLM_PROVIDERS);

interface LlmPolicyConfig {
  LLM_DEFAULT_PROVIDER: typeof SUPPORTED_LLM_PROVIDER_VALUES[number];
  LLM_DEFAULT_MODEL: string;
  LLM_PROVIDERS_JSON: string;
  LLM_ALLOWED_REASONING_SUMMARY_MODES: string;
  LLM_ALLOWED_REASONING_EFFORTS: string;
}

const providerModelsSchema = z.array(z.string().trim().min(1)).min(1).superRefine((models, ctx) => {
  if (new Set(models).size !== models.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider model arrays must contain unique models'
    });
  }
});

const configuredProvidersSchema = z.object({
  openai: providerModelsSchema.optional(),
  anthropic: providerModelsSchema.optional(),
  gemini: providerModelsSchema.optional()
}).strict().superRefine((providers, ctx) => {
  if (Object.keys(providers).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at least one provider must be configured'
    });
  }
});

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

export function parseConfiguredProvidersJson(value: string): ProviderModelMap {
  const configured = configuredProvidersSchema.parse(JSON.parse(value) as unknown);
  const providerModels = emptyProviderModelMap();
  for (const provider of SUPPORTED_LLM_PROVIDER_VALUES) {
    if (configured[provider]) {
      providerModels[provider] = configured[provider];
    }
  }
  return providerModels;
}

export function configuredProviders(
  providerModels: ProviderModelMap
): Array<typeof SUPPORTED_LLM_PROVIDER_VALUES[number]> {
  return SUPPORTED_LLM_PROVIDER_VALUES.filter((provider) => providerModels[provider].length > 0);
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
  let providerModelMap: ProviderModelMap | undefined;
  try {
    providerModelMap = parseConfiguredProvidersJson(value.LLM_PROVIDERS_JSON);
  } catch {
    addConfigIssue(
      ctx,
      'LLM_PROVIDERS_JSON',
      'LLM_PROVIDERS_JSON must be a JSON object mapping supported providers to non-empty unique model arrays'
    );
  }
  if (providerModelMap) {
    const allowedProviders = configuredProviders(providerModelMap);
    if (!allowedProviders.includes(value.LLM_DEFAULT_PROVIDER)) {
      addConfigIssue(ctx, 'LLM_DEFAULT_PROVIDER', 'LLM_DEFAULT_PROVIDER must be configured in LLM_PROVIDERS_JSON');
    } else if (!providerModelMap[value.LLM_DEFAULT_PROVIDER].includes(value.LLM_DEFAULT_MODEL)) {
      addConfigIssue(ctx, 'LLM_DEFAULT_MODEL', 'LLM_DEFAULT_MODEL must be available for LLM_DEFAULT_PROVIDER');
    }
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
