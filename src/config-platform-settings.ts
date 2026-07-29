import { z } from 'zod';
import type { WorkspaceMemberDiscoveryMode } from './types/domain.js';

export const PLATFORM_SETTING_KEYS = ['member_discovery', 'ai_policy', 'user_sign_in_methods'] as const;
export type PlatformSettingKey = typeof PLATFORM_SETTING_KEYS[number];
export const LEGACY_PLATFORM_SETTING_KEY = 'password_signup' as const;
export type PlatformSettingStorageKey = PlatformSettingKey | typeof LEGACY_PLATFORM_SETTING_KEY;

export const USER_SIGN_IN_METHODS = ['password', 'oidc'] as const;
export type UserSignInMethod = typeof USER_SIGN_IN_METHODS[number];

export const platformSettingsConfigFields = {
  WORKSPACE_MEMBER_DISCOVERY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PLATFORM_SETTINGS_POLICY_JSON: z.string().optional()
};

const memberDiscoveryModes = ['disabled', 'exact_email', 'directory'] as const;

const platformSettingsPolicySchema = z.object({
  memberDiscovery: z.object({
    allowedModes: z.array(z.enum(memberDiscoveryModes)).min(1).default(['disabled', 'exact_email']),
    defaultMode: z.enum(memberDiscoveryModes).default('exact_email')
  }).strict().default({}),
  aiPolicy: z.object({
    runtimeEditable: z.boolean().default(true)
  }).strict().default({}),
  userSignInMethods: z.object({
    allowedMethods: z.array(z.enum(USER_SIGN_IN_METHODS)).min(1).optional(),
    defaultMethods: z.array(z.enum(USER_SIGN_IN_METHODS)).min(1).optional()
  }).strict().optional(),
  // Retained only to accept existing deployment policy JSON. The runtime
  // setting was superseded by userSignInMethods.
  passwordSignup: z.object({
    allowedValues: z.array(z.boolean()).min(1).default([false, true]),
    defaultValue: z.boolean().optional()
  }).strict().default({})
}).strict().default({});

export interface PlatformSettingsDeploymentPolicy {
  memberDiscovery: {
    allowedModes: WorkspaceMemberDiscoveryMode[];
    defaultMode: WorkspaceMemberDiscoveryMode;
  };
  aiPolicy: {
    runtimeEditable: boolean;
  };
  userSignInMethods: {
    allowedMethods: UserSignInMethod[];
    defaultMethods: UserSignInMethod[];
  };
}

export function resolvePlatformSettingsDeploymentPolicy(
  rawJson: string | undefined,
  configuredSignInMethods: UserSignInMethod[]
): PlatformSettingsDeploymentPolicy {
  let raw: unknown = {};
  if (rawJson?.trim()) {
    try {
      raw = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`PLATFORM_SETTINGS_POLICY_JSON must be valid JSON: ${(error as Error).message}`);
    }
  }
  const parsed = platformSettingsPolicySchema.parse(raw);
  const allowedModes = [...new Set(parsed.memberDiscovery.allowedModes)];
  if (!allowedModes.includes(parsed.memberDiscovery.defaultMode)) {
    throw new Error('platformSettings.memberDiscovery.defaultMode must be included in allowedModes');
  }
  const configuredMethods = [...new Set(configuredSignInMethods)];
  if (configuredMethods.length === 0) {
    throw new Error('At least one deployment-configured user sign-in method is required');
  }
  const allowedMethods = [...new Set(parsed.userSignInMethods?.allowedMethods || configuredMethods)];
  if (allowedMethods.some((method) => !configuredMethods.includes(method))) {
    throw new Error('platformSettings.userSignInMethods.allowedMethods must be deployment-configured');
  }
  if (allowedMethods.length === 0) {
    throw new Error('platformSettings.userSignInMethods.allowedMethods must include at least one method');
  }
  const defaultMethods = [...new Set(parsed.userSignInMethods?.defaultMethods || allowedMethods)];
  if (defaultMethods.some((method) => !allowedMethods.includes(method))) {
    throw new Error('platformSettings.userSignInMethods.defaultMethods must be included in allowedMethods');
  }
  if (defaultMethods.length === 0) {
    throw new Error('platformSettings.userSignInMethods.defaultMethods must include at least one method');
  }
  return {
    memberDiscovery: {
      allowedModes,
      defaultMode: parsed.memberDiscovery.defaultMode
    },
    aiPolicy: {
      runtimeEditable: parsed.aiPolicy.runtimeEditable
    },
    userSignInMethods: {
      allowedMethods,
      defaultMethods
    }
  };
}

export function resolvePlatformSettingsRuntimeConfig(
  rawJson: string | undefined,
  configuredPasswordSignup: boolean | undefined,
  passwordAuthEnabled: boolean,
  oidcEnabled: boolean,
  production: boolean
) {
  const configuredSignInMethods: UserSignInMethod[] = [
    ...(passwordAuthEnabled ? ['password' as const] : []),
    ...(oidcEnabled ? ['oidc' as const] : [])
  ];
  return {
    PLATFORM_SETTINGS_POLICY: resolvePlatformSettingsDeploymentPolicy(rawJson, configuredSignInMethods),
    // Deprecated compatibility value. Runtime access is controlled only by
    // user_sign_in_methods.
    PASSWORD_SIGNUP_ENABLED: configuredPasswordSignup ?? !production
  };
}
