import type { PlatformSettingKey, UserSignInMethod } from '../config-platform-settings.js';
import type { LlmProvider, ReasoningEffort, ReasoningSummaryMode, WorkspaceMemberDiscoveryMode } from '../types/domain.js';
import type { ProviderModelMap } from '../config-llm-policy.js';
import type { KubernetesRbacAdditionsOverride, KubernetesRbacAdditionsValue } from './kubernetes-rbac-additions.js';

export interface AiPlatformPolicy {
  defaultProvider: LlmProvider;
  defaultModel: string;
  providerModels: ProviderModelMap;
  reasoningSummariesEnabled: boolean;
  reasoningSummaryModes: ReasoningSummaryMode[];
  reasoningEfforts: ReasoningEffort[];
}

export interface PlatformSettingValueMap {
  member_discovery: { mode: WorkspaceMemberDiscoveryMode };
  ai_policy: AiPlatformPolicy;
  user_sign_in_methods: { methods: UserSignInMethod[] };
  help_links: { documentationUrl: string; supportUrl: string };
  kubernetes_rbac_additions: KubernetesRbacAdditionsValue;
}

export interface PlatformSettingOverrideValueMap {
  member_discovery: PlatformSettingValueMap['member_discovery'];
  ai_policy: PlatformSettingValueMap['ai_policy'];
  user_sign_in_methods: PlatformSettingValueMap['user_sign_in_methods'];
  help_links: PlatformSettingValueMap['help_links'];
  kubernetes_rbac_additions: KubernetesRbacAdditionsOverride;
}

export interface PlatformSettingState<K extends PlatformSettingKey = PlatformSettingKey> {
  key: K;
  value: PlatformSettingValueMap[K];
  deploymentDefault: PlatformSettingValueMap[K];
  overrideValue?: PlatformSettingOverrideValueMap[K];
  source: 'deployment_default' | 'runtime_override' | 'runtime_override_constrained';
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  editable: boolean;
  constraints: Record<string, unknown>;
  warning?: string;
}

export type PlatformSettingStateMap = {
  [K in PlatformSettingKey]: PlatformSettingState<K>;
};
