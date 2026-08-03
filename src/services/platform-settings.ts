import Redis from 'ioredis';
import { z } from 'zod';
import { config } from '../config.js';
import {
  LEGACY_PLATFORM_SETTING_KEY,
  PLATFORM_SETTING_KEYS,
  USER_SIGN_IN_METHODS,
  type PlatformSettingKey,
  type UserSignInMethod
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
  SUPPORTED_LLM_PROVIDER_VALUES
} from '../config-llm-policy.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';
import {
  listPlatformSettingOverrides,
  type PlatformSettingOverride
} from '../store/repository-platform-settings.js';
import type { WorkspaceMemberDiscoveryMode } from '../types/domain.js';
import {
  type KubernetesRbacAdditionsOverride,
  type KubernetesRbacAdditionsValue
} from './kubernetes-rbac-additions.js';
import {
  effectiveKubernetesRbacAdditions as mergeEffectiveKubernetesRbacAdditions,
  kubernetesRbacAdditionsState,
  parseKubernetesRbacAdditionsOverride,
  validateKubernetesRbacAdditionsOverride
} from './platform-setting-kubernetes-rbac.js';
import { helpLinksState, parseHelpLinksValue } from './platform-setting-help-links.js';
import type {
  AiPlatformPolicy,
  PlatformSettingOverrideValueMap,
  PlatformSettingState,
  PlatformSettingStateMap,
  PlatformSettingValueMap
} from './platform-setting-types.js';
export type { AiPlatformPolicy, PlatformSettingState } from './platform-setting-types.js';

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

const userSignInMethodsValueSchema = z.object({
  methods: z.array(z.enum(USER_SIGN_IN_METHODS)).min(1).refine(
    (methods) => new Set(methods).size === methods.length,
    'methods must not contain duplicates'
  )
}).strict();

const legacyPasswordSignupValueSchema = z.object({
  enabled: z.boolean()
}).strict();

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
      resetEnabled: config.PASSWORD_RESET_ENABLED,
      oidcEnabled: config.OIDC_ENABLED,
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

function settingOverrideMap(overrides: PlatformSettingOverride[]): Map<PlatformSettingKey | typeof LEGACY_PLATFORM_SETTING_KEY, PlatformSettingOverride> {
  return new Map(overrides
    .filter((entry) => PLATFORM_SETTING_KEYS.includes(entry.key as PlatformSettingKey) || entry.key === LEGACY_PLATFORM_SETTING_KEY)
    .map((entry) => [entry.key, entry]));
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

function signInMethodBlockers(allowedMethods: UserSignInMethod[]): Partial<Record<UserSignInMethod, string[]>> {
  const blockers: Partial<Record<UserSignInMethod, string[]>> = {};
  for (const method of USER_SIGN_IN_METHODS) {
    if (!allowedMethods.includes(method)) {
      blockers[method] = [
        method === 'password'
          ? 'Password sign-in is disabled by the deployment policy.'
          : 'OIDC sign-in is disabled by the deployment policy.'
      ];
    }
  }
  return blockers;
}

function userSignInMethodsState(
  entry?: PlatformSettingOverride,
  legacyEntry?: PlatformSettingOverride
): PlatformSettingState<'user_sign_in_methods'> {
  const policy = config.PLATFORM_SETTINGS_POLICY.userSignInMethods;
  const deploymentDefault = { methods: policy.defaultMethods };
  const parsed = entry?.overrideValue === null || entry?.overrideValue === undefined
    ? undefined
    : userSignInMethodsValueSchema.safeParse(entry.overrideValue);
  const legacyParsed = !entry && legacyEntry?.overrideValue !== null && legacyEntry?.overrideValue !== undefined
    ? legacyPasswordSignupValueSchema.safeParse(legacyEntry.overrideValue)
    : undefined;
  // A legacy signup-only override did not control password login or OIDC.
  // Mapping it to the deployment default preserves existing authentication
  // access until an administrator writes the new explicit policy.
  const overrideValue = parsed?.success
    ? parsed.data
    : legacyParsed?.success
      ? deploymentDefault
      : undefined;
  const constrainedMethods = overrideValue?.methods.filter((method) => policy.allowedMethods.includes(method)) || [];
  const value = constrainedMethods.length ? { methods: constrainedMethods } : deploymentDefault;
  const constrained = Boolean(overrideValue && JSON.stringify(value) !== JSON.stringify(overrideValue));
  const usingLegacyValue = Boolean(legacyParsed?.success);
  return {
    key: 'user_sign_in_methods',
    value,
    deploymentDefault,
    ...(overrideValue ? { overrideValue } : {}),
    source: overrideValue
      ? constrained || usingLegacyValue
        ? 'runtime_override_constrained'
        : 'runtime_override'
      : 'deployment_default',
    version: entry?.version || legacyEntry?.version || 0,
    ...(entry?.updatedBy || legacyEntry?.updatedBy ? { updatedBy: entry?.updatedBy || legacyEntry?.updatedBy } : {}),
    ...(entry?.updatedAt || legacyEntry?.updatedAt ? { updatedAt: entry?.updatedAt || legacyEntry?.updatedAt } : {}),
    editable: policy.allowedMethods.length > 1,
    constraints: {
      allowedMethods: policy.allowedMethods,
      methodBlockers: signInMethodBlockers(policy.allowedMethods)
    },
    ...(usingLegacyValue
      ? { warning: 'A legacy password signup setting is in use. Save this setting to apply an explicit sign-in method policy.' }
      : constrained
        ? { warning: 'The stored sign-in methods were narrowed to the current deployment policy.' }
        : {})
  };
}

function buildStates(overrides: PlatformSettingOverride[]): PlatformSettingStateMap {
  const map = settingOverrideMap(overrides);
  return {
    member_discovery: memberDiscoveryState(map.get('member_discovery')),
    ai_policy: aiPolicyState(map.get('ai_policy')),
    user_sign_in_methods: userSignInMethodsState(
      map.get('user_sign_in_methods'),
      map.get(LEGACY_PLATFORM_SETTING_KEY)
    ),
    help_links: helpLinksState(map.get('help_links')),
    kubernetes_rbac_additions: kubernetesRbacAdditionsState(
      map.get('kubernetes_rbac_additions'),
      config.PLATFORM_SETTINGS_POLICY.kubernetesRbacAdditions.profiles,
      config.PLATFORM_SETTINGS_POLICY.kubernetesRbacAdditions.runtimeEditable
    )
  };
}

export function parsePlatformSettingValue<K extends PlatformSettingKey>(
  key: K,
  value: unknown
): PlatformSettingOverrideValueMap[K] {
  const parsed = key === 'member_discovery'
    ? memberDiscoveryValueSchema.parse(value)
    : key === 'ai_policy'
      ? aiPolicyValueSchema.parse(value)
      : key === 'user_sign_in_methods'
        ? userSignInMethodsValueSchema.parse(value)
        : key === 'help_links'
          ? parseHelpLinksValue(value)
          : parseKubernetesRbacAdditionsOverride(
              value,
              getPlatformSetting('kubernetes_rbac_additions').deploymentDefault
            );
  return parsed as PlatformSettingOverrideValueMap[K];
}

export function validatePlatformSettingOverride<K extends PlatformSettingKey>(
  key: K,
  value: PlatformSettingOverrideValueMap[K]
): string | null {
  const current = resolvedStates()[key];
  if (!current.editable) return 'This setting is fixed by the deployment policy.';
  if (key === 'member_discovery') {
    const mode = (value as PlatformSettingValueMap['member_discovery']).mode;
    return (current.constraints.allowedModes as WorkspaceMemberDiscoveryMode[]).includes(mode)
      ? null
      : 'This discovery mode is not allowed by the deployment policy.';
  }
  if (key === 'user_sign_in_methods') {
    const methods = (value as PlatformSettingValueMap['user_sign_in_methods']).methods;
    const allowedMethods = current.constraints.allowedMethods as UserSignInMethod[];
    if (methods.length === 0) return 'At least one user sign-in method must be enabled.';
    if (methods.some((method) => !allowedMethods.includes(method))) {
      return 'One or more sign-in methods are not allowed by the deployment policy.';
    }
    return null;
  }
  if (key === 'kubernetes_rbac_additions') {
    return validateKubernetesRbacAdditionsOverride(
      current.deploymentDefault as KubernetesRbacAdditionsValue,
      value as KubernetesRbacAdditionsOverride
    );
  }
  if (key === 'help_links') return null;
  const candidate = value as PlatformSettingValueMap['ai_policy'];
  const constrained = constrainedAiPolicy(candidate, deploymentAiPolicy());
  return JSON.stringify(candidate) === JSON.stringify(constrained)
    ? null
    : 'AI policy may narrow, but cannot expand, the deployment ceiling.';
}

/** Resolve an accepted override into the value administrators and onboarding consumers will observe. */
export function effectivePlatformSettingOverride<K extends PlatformSettingKey>(
  key: K,
  value: PlatformSettingOverrideValueMap[K]
): PlatformSettingValueMap[K] {
  if (key !== 'kubernetes_rbac_additions') return value as unknown as PlatformSettingValueMap[K];
  const current = getPlatformSetting('kubernetes_rbac_additions');
  return mergeEffectiveKubernetesRbacAdditions(
    current.deploymentDefault,
    value as KubernetesRbacAdditionsOverride
  ) as PlatformSettingValueMap[K];
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
      : key === 'user_sign_in_methods'
        ? userSignInMethodsState()
        : key === 'help_links'
          ? helpLinksState()
          : kubernetesRbacAdditionsState(
              undefined,
              config.PLATFORM_SETTINGS_POLICY.kubernetesRbacAdditions.profiles,
              config.PLATFORM_SETTINGS_POLICY.kubernetesRbacAdditions.runtimeEditable
            );
  return structuredClone(state) as PlatformSettingState<K>;
}

export function workspaceMemberDiscoveryMode(): WorkspaceMemberDiscoveryMode {
  return resolvedStates().member_discovery.value.mode;
}

export function effectiveAiPlatformPolicy(): AiPlatformPolicy {
  return structuredClone(resolvedStates().ai_policy.value);
}

export function effectiveUserSignInMethods(): UserSignInMethod[] {
  return [...resolvedStates().user_sign_in_methods.value.methods];
}

export function effectiveHelpLinks(): PlatformSettingValueMap['help_links'] {
  return structuredClone(resolvedStates().help_links.value);
}

export function effectiveKubernetesRbacAdditions(): KubernetesRbacAdditionsValue {
  return structuredClone(resolvedStates().kubernetes_rbac_additions.value);
}

export function passwordSignInEnabled(): boolean {
  return effectiveUserSignInMethods().includes('password');
}

export function oidcSignInEnabled(): boolean {
  return effectiveUserSignInMethods().includes('oidc');
}

export function passwordSignupEnabled(): boolean {
  return passwordSignInEnabled() && passwordSignupOperationalBlockers().length === 0;
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
