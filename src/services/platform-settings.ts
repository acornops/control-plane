import Redis from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import {
  PLATFORM_SETTING_KEYS,
  type PlatformSettingKey
} from '../config-platform-settings.js';
import {
  configuredProviders,
  DEFAULT_REASONING_EFFORT,
  flatProviderModels,
  parseConfiguredProvidersJson,
  parseConfiguredReasoningEfforts,
  parseConfiguredReasoningSummaryModes,
  REASONING_EFFORT_VALUES,
  REASONING_SUMMARY_MODE_VALUES,
  SUPPORTED_LLM_PROVIDER_VALUES,
  type ProviderModelMap
} from '../config-llm-policy.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';
import {
  listPlatformSettingOverrides,
  type PlatformSettingOverride
} from '../store/repository-platform-settings.js';
import type {
  LlmProvider,
  ReasoningEffort,
  ReasoningSummaryMode,
  WorkspaceMemberDiscoveryMode
} from '../types/domain.js';

const settingChannel = 'cp:platform-settings';
const refreshIntervalMs = 30_000;

const memberDiscoveryValueSchema = z.object({
  mode: z.enum(['disabled', 'exact_email', 'directory'])
}).strict();

const providerModelsValueSchema = z.object({
  openai: z.array(z.string().trim().min(1)),
  anthropic: z.array(z.string().trim().min(1)),
  gemini: z.array(z.string().trim().min(1))
}).strict();

const aiPolicyValueSchema = z.object({
  defaultProvider: z.enum(SUPPORTED_LLM_PROVIDER_VALUES),
  defaultModel: z.string().trim().min(1),
  providerModels: providerModelsValueSchema,
  reasoningSummariesEnabled: z.boolean(),
  reasoningSummaryModes: z.array(z.enum(REASONING_SUMMARY_MODE_VALUES)).min(1),
  reasoningEfforts: z.array(z.enum(REASONING_EFFORT_VALUES)).min(1)
}).strict();

const passwordSignupValueSchema = z.object({
  enabled: z.boolean()
}).strict();

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
  password_signup: { enabled: boolean };
}

type PlatformSettingSource = 'deployment_default' | 'runtime_override' | 'runtime_override_constrained';

export interface PlatformSettingState<K extends PlatformSettingKey = PlatformSettingKey> {
  key: K;
  value: PlatformSettingValueMap[K];
  deploymentDefault: PlatformSettingValueMap[K];
  overrideValue?: PlatformSettingValueMap[K];
  source: PlatformSettingSource;
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  editable: boolean;
  constraints: Record<string, unknown>;
  warning?: string;
}

type PlatformSettingStateMap = {
  [K in PlatformSettingKey]: PlatformSettingState<K>;
};

let loadedOverrides: PlatformSettingOverride[] = [];
let states = buildStates(loadedOverrides);
let statesDeploymentFingerprint = deploymentSettingsFingerprint();
let subscriber: Redis | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function deploymentSettingsFingerprint(): string {
  return JSON.stringify({
    policy: config.PLATFORM_SETTINGS_POLICY,
    ai: {
      defaultProvider: config.LLM_DEFAULT_PROVIDER,
      defaultModel: config.LLM_DEFAULT_MODEL,
      providers: config.LLM_PROVIDERS_JSON,
      reasoningSummariesEnabled: config.LLM_REASONING_SUMMARIES_ENABLED,
      reasoningSummaryModes: config.LLM_ALLOWED_REASONING_SUMMARY_MODES,
      reasoningEfforts: config.LLM_ALLOWED_REASONING_EFFORTS
    },
    password: {
      authEnabled: config.PASSWORD_AUTH_ENABLED,
      verificationRequired: config.PASSWORD_EMAIL_VERIFICATION_REQUIRED,
      allowUnverified: config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL,
      deliveryMode: config.EMAIL_DELIVERY_MODE,
      allowProductionLog: config.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION,
      publicBaseUrl: config.EMAIL_PUBLIC_BASE_URL,
      smtpHost: config.SMTP_HOST,
      smtpUsername: config.SMTP_USERNAME,
      smtpPasswordConfigured: Boolean(config.SMTP_PASSWORD)
    }
  });
}

function resolvedStates(): PlatformSettingStateMap {
  const fingerprint = deploymentSettingsFingerprint();
  if (fingerprint !== statesDeploymentFingerprint) {
    states = buildStates(loadedOverrides);
    statesDeploymentFingerprint = fingerprint;
  }
  return states;
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

export function passwordSignupOperationalBlockers(): string[] {
  const blockers: string[] = [];
  if (!config.PASSWORD_AUTH_ENABLED) {
    blockers.push('Password authentication is disabled by the deployment.');
  }
  if (!config.PASSWORD_EMAIL_VERIFICATION_REQUIRED && !config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL) {
    blockers.push('The deployment does not permit unverified password signup.');
  }
  if (config.PASSWORD_EMAIL_VERIFICATION_REQUIRED) {
    if (
      config.NODE_ENV === 'production' &&
      new URL(config.EMAIL_PUBLIC_BASE_URL).protocol !== 'https:'
    ) {
      blockers.push('Production verification links require an HTTPS external base URL.');
    }
    if (config.EMAIL_DELIVERY_MODE === 'disabled') {
      blockers.push('Email delivery is disabled.');
    }
    if (
      config.NODE_ENV === 'production' &&
      config.EMAIL_DELIVERY_MODE === 'log' &&
      !config.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION
    ) {
      blockers.push('Production signup cannot use log-only email delivery.');
    }
    if (
      config.NODE_ENV === 'production' &&
      config.EMAIL_DELIVERY_MODE === 'smtp' &&
      (!config.SMTP_HOST || !config.SMTP_USERNAME || !config.SMTP_PASSWORD)
    ) {
      blockers.push('Production SMTP delivery is not fully configured.');
    }
  }
  return blockers;
}

function settingOverrideMap(overrides: PlatformSettingOverride[]): Map<PlatformSettingKey, PlatformSettingOverride> {
  return new Map(overrides.filter((entry) => PLATFORM_SETTING_KEYS.includes(entry.key)).map((entry) => [entry.key, entry]));
}

function memberDiscoveryState(entry?: PlatformSettingOverride): PlatformSettingState<'member_discovery'> {
  const policy = config.PLATFORM_SETTINGS_POLICY.memberDiscovery;
  const deploymentDefault = { mode: policy.defaultMode };
  const parsed = entry?.overrideValue === null || entry?.overrideValue === undefined
    ? undefined
    : memberDiscoveryValueSchema.safeParse(entry.overrideValue);
  const overrideValue = parsed?.success ? parsed.data : undefined;
  const permitted = overrideValue && policy.allowedModes.includes(overrideValue.mode);
  return {
    key: 'member_discovery',
    value: permitted ? overrideValue : deploymentDefault,
    deploymentDefault,
    ...(overrideValue ? { overrideValue } : {}),
    source: permitted
      ? 'runtime_override'
      : overrideValue
        ? 'runtime_override_constrained'
        : 'deployment_default',
    version: entry?.version || 0,
    ...(entry?.updatedBy ? { updatedBy: entry.updatedBy } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    editable: policy.allowedModes.length > 1,
    constraints: { allowedModes: policy.allowedModes },
    ...(overrideValue && !permitted
      ? { warning: 'The stored mode is blocked by the current deployment policy.' }
      : {})
  };
}

function constrainedAiPolicy(override: AiPlatformPolicy, ceiling: AiPlatformPolicy): AiPlatformPolicy {
  const providerModels = {
    openai: unique(override.providerModels.openai.filter((model) => ceiling.providerModels.openai.includes(model))),
    anthropic: unique(override.providerModels.anthropic.filter((model) => ceiling.providerModels.anthropic.includes(model))),
    gemini: unique(override.providerModels.gemini.filter((model) => ceiling.providerModels.gemini.includes(model)))
  };
  if (flatProviderModels(providerModels).length === 0) {
    return ceiling;
  }
  const providers = configuredProviders(providerModels);
  const defaultProvider = providers.includes(override.defaultProvider)
    ? override.defaultProvider
    : providers.includes(ceiling.defaultProvider)
      ? ceiling.defaultProvider
      : providers[0];
  const defaultModel = providerModels[defaultProvider].includes(override.defaultModel)
    ? override.defaultModel
    : providerModels[defaultProvider].includes(ceiling.defaultModel)
      ? ceiling.defaultModel
      : providerModels[defaultProvider][0];
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
    reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : [ceiling.reasoningEfforts[0] || DEFAULT_REASONING_EFFORT]
  };
}

function aiPolicyState(entry?: PlatformSettingOverride): PlatformSettingState<'ai_policy'> {
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
      providerModels: deploymentDefault.providerModels,
      reasoningSummariesEnabled: deploymentDefault.reasoningSummariesEnabled,
      reasoningSummaryModes: deploymentDefault.reasoningSummaryModes,
      reasoningEfforts: deploymentDefault.reasoningEfforts
    },
    ...(constrained ? { warning: 'The stored AI policy was narrowed to the current deployment ceiling.' } : {})
  };
}

function passwordSignupState(entry?: PlatformSettingOverride): PlatformSettingState<'password_signup'> {
  const policy = config.PLATFORM_SETTINGS_POLICY.passwordSignup;
  const deploymentDefault = { enabled: policy.defaultValue };
  const parsed = entry?.overrideValue === null || entry?.overrideValue === undefined
    ? undefined
    : passwordSignupValueSchema.safeParse(entry.overrideValue);
  const overrideValue = parsed?.success ? parsed.data : undefined;
  const blockers = passwordSignupOperationalBlockers();
  const permitted = overrideValue && policy.allowedValues.includes(overrideValue.enabled);
  const requested = permitted ? overrideValue : deploymentDefault;
  const value = requested.enabled && blockers.length ? { enabled: false } : requested;
  const constrained = Boolean(overrideValue && (!permitted || value.enabled !== overrideValue.enabled));
  return {
    key: 'password_signup',
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
    editable: policy.allowedValues.length > 1,
    constraints: {
      allowedValues: policy.allowedValues,
      enablementBlockers: blockers
    },
    ...(constrained ? { warning: blockers[0] || 'The stored value is blocked by the current deployment policy.' } : {})
  };
}

function buildStates(overrides: PlatformSettingOverride[]): PlatformSettingStateMap {
  const map = settingOverrideMap(overrides);
  return {
    member_discovery: memberDiscoveryState(map.get('member_discovery')),
    ai_policy: aiPolicyState(map.get('ai_policy')),
    password_signup: passwordSignupState(map.get('password_signup'))
  };
}

export function parsePlatformSettingValue<K extends PlatformSettingKey>(
  key: K,
  value: unknown
): PlatformSettingValueMap[K] {
  const parsed = key === 'member_discovery'
    ? memberDiscoveryValueSchema.parse(value)
    : key === 'ai_policy'
      ? aiPolicyValueSchema.parse(value)
      : passwordSignupValueSchema.parse(value);
  return parsed as PlatformSettingValueMap[K];
}

export function validatePlatformSettingOverride<K extends PlatformSettingKey>(
  key: K,
  value: PlatformSettingValueMap[K]
): string | null {
  const current = resolvedStates()[key];
  if (!current.editable) return 'This setting is fixed by the deployment policy.';
  if (key === 'member_discovery') {
    const mode = (value as PlatformSettingValueMap['member_discovery']).mode;
    return (current.constraints.allowedModes as WorkspaceMemberDiscoveryMode[]).includes(mode)
      ? null
      : 'This discovery mode is not allowed by the deployment policy.';
  }
  if (key === 'password_signup') {
    const enabled = (value as PlatformSettingValueMap['password_signup']).enabled;
    if (!(current.constraints.allowedValues as boolean[]).includes(enabled)) {
      return 'This password-signup value is not allowed by the deployment policy.';
    }
    const blockers = current.constraints.enablementBlockers as string[];
    return enabled && blockers.length ? blockers[0] : null;
  }
  const candidate = value as PlatformSettingValueMap['ai_policy'];
  const constrained = constrainedAiPolicy(candidate, deploymentAiPolicy());
  return JSON.stringify(candidate) === JSON.stringify(constrained)
    ? null
    : 'AI policy may narrow, but cannot expand, the deployment ceiling.';
}

export async function refreshPlatformSettings(): Promise<void> {
  applyRefreshedPlatformSettingOverrides(await listPlatformSettingOverrides());
}

export async function initializePlatformSettings(): Promise<void> {
  await refreshPlatformSettings();
}

export function applyPlatformSettingOverrides(overrides: PlatformSettingOverride[]): void {
  loadedOverrides = overrides.map((entry) => structuredClone(entry));
  states = buildStates(loadedOverrides);
  statesDeploymentFingerprint = deploymentSettingsFingerprint();
}

export function applyRefreshedPlatformSettingOverrides(overrides: PlatformSettingOverride[]): void {
  const refreshed = new Map(overrides.map((entry) => [entry.key, entry]));
  for (const current of loadedOverrides) {
    const incoming = refreshed.get(current.key);
    if (!incoming || incoming.version < current.version) {
      refreshed.set(current.key, current);
    }
  }
  applyPlatformSettingOverrides([...refreshed.values()]);
}

export function applyPlatformSettingOverride(settingOverride: PlatformSettingOverride): void {
  const current = loadedOverrides.find((entry) => entry.key === settingOverride.key);
  if (current && current.version >= settingOverride.version) return;
  applyPlatformSettingOverrides([
    ...loadedOverrides.filter((entry) => entry.key !== settingOverride.key),
    settingOverride
  ]);
}

export function listPlatformSettings(): PlatformSettingState[] {
  const current = resolvedStates();
  return PLATFORM_SETTING_KEYS.map((key) => structuredClone(current[key]));
}

export function getPlatformSetting<K extends PlatformSettingKey>(key: K): PlatformSettingState<K> {
  return structuredClone(resolvedStates()[key]) as PlatformSettingState<K>;
}

export function getPlatformSettingWithoutOverride<K extends PlatformSettingKey>(
  key: K
): PlatformSettingState<K> {
  const state = key === 'member_discovery'
    ? memberDiscoveryState()
    : key === 'ai_policy'
      ? aiPolicyState()
      : passwordSignupState();
  return structuredClone(state) as PlatformSettingState<K>;
}

export function workspaceMemberDiscoveryMode(): WorkspaceMemberDiscoveryMode {
  return resolvedStates().member_discovery.value.mode;
}

export function effectiveAiPlatformPolicy(): AiPlatformPolicy {
  return structuredClone(resolvedStates().ai_policy.value);
}

export function passwordSignupEnabled(): boolean {
  return resolvedStates().password_signup.value.enabled;
}

export async function publishPlatformSettingsChanged(): Promise<void> {
  await redis.publish(settingChannel, JSON.stringify({ originInstanceId: config.CONTROL_PLANE_INSTANCE_ID }));
}

export async function startPlatformSettingsRefresh(): Promise<void> {
  subscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
  subscriber.on('message', () => {
    void refreshPlatformSettings().catch((error) => {
      logger.warn({ error }, 'Failed refreshing platform settings after invalidation');
    });
  });
  await subscriber.connect();
  await subscriber.subscribe(settingChannel);
  refreshTimer = setInterval(() => {
    void refreshPlatformSettings().catch((error) => {
      logger.warn({ error }, 'Periodic platform settings refresh failed');
    });
  }, refreshIntervalMs);
  refreshTimer.unref();
}

export async function stopPlatformSettingsRefresh(): Promise<void> {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  await subscriber?.quit().catch(() => undefined);
  subscriber = undefined;
}
