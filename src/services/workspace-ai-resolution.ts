import { repo } from '../store/repository.js';
import { LlmProvider } from '../types/domain.js';
import { listWorkspaceProviderCredentials, type ProviderCredentialStatus } from './llm-provider-credential-client.js';
import {
  defaultModel,
  defaultProvider,
  parseAllowedModels,
  parseAllowedProviders
} from './llm-policy.js';

export interface WorkspaceLlmSettingsResolution {
  provider: LlmProvider;
  model: string;
  allowedProviders: LlmProvider[];
  allowedModels: string[];
  credentialConfigured: boolean;
}

export function effectiveAllowedProviders(credentials: ProviderCredentialStatus[]): LlmProvider[] {
  const allowed = parseAllowedProviders();
  return allowed.filter((provider) => credentials.some((entry) => entry.provider === provider && entry.enabled));
}

export async function resolveWorkspaceLlmSettings(
  workspaceId: string,
  runSnapshot?: { provider: LlmProvider; model: string }
): Promise<WorkspaceLlmSettingsResolution> {
  const [settings, credentials] = await Promise.all([
    repo.getWorkspaceAiSettings(workspaceId),
    listWorkspaceProviderCredentials(workspaceId)
  ]);
  const provider = runSnapshot?.provider || settings?.defaultProvider || defaultProvider();
  const model = runSnapshot?.model || settings?.defaultModel || defaultModel();
  const credential = credentials.providers.find((entry) => entry.provider === provider);
  const allowedProviders = effectiveAllowedProviders(credentials.providers);
  return {
    provider,
    model,
    allowedProviders,
    allowedModels: parseAllowedModels(),
    credentialConfigured: Boolean(credential?.configured)
  };
}
