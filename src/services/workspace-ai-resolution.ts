import { repo } from '../store/repository.js';
import { LlmProvider, ReasoningEffort, ReasoningSummaryMode } from '../types/domain.js';
import { listWorkspaceProviderCredentials, type ProviderCredentialStatus } from './llm-provider-credential-client.js';
import {
  defaultModel,
  defaultProvider,
  parseAllowedModels,
  parseAllowedProviderModels,
  parseAllowedProviders,
  parseAllowedReasoningEfforts,
  parseAllowedReasoningSummaryModes
} from './llm-policy.js';
import { config } from '../config.js';
import { DEFAULT_REASONING_EFFORT, type ProviderModelMap } from '../config-llm-policy.js';

export interface WorkspaceLlmSettingsResolution {
  provider: LlmProvider;
  model: string;
  allowedProviders: LlmProvider[];
  allowedProviderModels: ProviderModelMap;
  allowedModels: string[];
  credentialConfigured: boolean;
  reasoning: {
    summary_mode: ReasoningSummaryMode;
    effort: ReasoningEffort;
  };
}

export function effectiveAllowedProviders(credentials: ProviderCredentialStatus[]): LlmProvider[] {
  const allowed = parseAllowedProviders();
  return allowed.filter((provider) => credentials.some((entry) => entry.provider === provider && entry.enabled));
}

export async function resolveWorkspaceLlmSettings(
  workspaceId: string,
  runSnapshot?: {
    provider?: LlmProvider;
    model?: string;
    reasoningSummaryMode?: ReasoningSummaryMode;
    reasoningEffort?: ReasoningEffort;
  }
): Promise<WorkspaceLlmSettingsResolution> {
  const [settings, credentials] = await Promise.all([
    repo.getWorkspaceAiSettings(workspaceId),
    listWorkspaceProviderCredentials(workspaceId)
  ]);
  const provider = runSnapshot?.provider || settings?.defaultProvider || defaultProvider();
  const model = runSnapshot?.model || settings?.defaultModel || defaultModel();
  const allowedReasoningSummaryModes = parseAllowedReasoningSummaryModes();
  const allowedReasoningEfforts = parseAllowedReasoningEfforts();
  const selectedSummaryMode = runSnapshot?.reasoningSummaryMode || settings?.reasoningSummaryMode || 'auto';
  const selectedEffort = runSnapshot?.reasoningEffort || settings?.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const summaryMode =
    config.LLM_REASONING_SUMMARIES_ENABLED && allowedReasoningSummaryModes.includes(selectedSummaryMode)
      ? selectedSummaryMode
      : 'off';
  const effort = allowedReasoningEfforts.includes(selectedEffort) ? selectedEffort : DEFAULT_REASONING_EFFORT;
  const credential = credentials.providers.find((entry) => entry.provider === provider);
  const allowedProviders = effectiveAllowedProviders(credentials.providers);
  return {
    provider,
    model,
    allowedProviders,
    allowedProviderModels: parseAllowedProviderModels(),
    allowedModels: parseAllowedModels(),
    credentialConfigured: Boolean(credential?.configured),
    reasoning: {
      summary_mode: summaryMode,
      effort
    }
  };
}
