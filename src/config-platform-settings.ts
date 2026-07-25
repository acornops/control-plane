import { z } from 'zod';
import type { WorkspaceMemberDiscoveryMode } from './types/domain.js';

export const PLATFORM_SETTING_KEYS = ['member_discovery', 'ai_policy', 'password_signup'] as const;
export type PlatformSettingKey = typeof PLATFORM_SETTING_KEYS[number];

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
  passwordSignup: {
    allowedValues: boolean[];
    defaultValue: boolean;
  };
}

export function resolvePlatformSettingsDeploymentPolicy(
  rawJson: string | undefined,
  passwordSignupDefault: boolean
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
  const allowedValues = [...new Set(parsed.passwordSignup.allowedValues)];
  const defaultValue = parsed.passwordSignup.defaultValue ?? passwordSignupDefault;
  if (!allowedValues.includes(defaultValue)) {
    throw new Error('platformSettings.passwordSignup.defaultValue must be included in allowedValues');
  }
  return {
    memberDiscovery: {
      allowedModes,
      defaultMode: parsed.memberDiscovery.defaultMode
    },
    aiPolicy: {
      runtimeEditable: parsed.aiPolicy.runtimeEditable
    },
    passwordSignup: {
      allowedValues,
      defaultValue
    }
  };
}

export function resolvePlatformSettingsRuntimeConfig(
  rawJson: string | undefined,
  configuredPasswordSignup: boolean | undefined,
  production: boolean
) {
  const passwordSignupEnabled = configuredPasswordSignup ?? !production;
  return {
    PLATFORM_SETTINGS_POLICY: resolvePlatformSettingsDeploymentPolicy(rawJson, passwordSignupEnabled),
    PASSWORD_SIGNUP_ENABLED: passwordSignupEnabled
  };
}
