import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import {
  applyPlatformSettingOverride,
  applyPlatformSettingOverrides,
  applyRefreshedPlatformSettingOverrides,
  getPlatformSetting,
  getPlatformSettingWithoutOverride,
  passwordSignupOperationalBlockers,
  validatePlatformSettingOverride
} from '../src/services/platform-settings.js';
import type { PlatformSettingOverride } from '../src/store/repository-platform-settings.js';

const mutableConfig = config as typeof config & {
  PASSWORD_AUTH_ENABLED: boolean;
  PASSWORD_EMAIL_VERIFICATION_REQUIRED: boolean;
  EMAIL_PUBLIC_BASE_URL: string;
  NODE_ENV: typeof config.NODE_ENV;
  PLATFORM_SETTINGS_POLICY: typeof config.PLATFORM_SETTINGS_POLICY;
};
const originalPolicy = config.PLATFORM_SETTINGS_POLICY;
const originalPasswordAuthEnabled = config.PASSWORD_AUTH_ENABLED;
const originalPasswordEmailVerificationRequired = config.PASSWORD_EMAIL_VERIFICATION_REQUIRED;
const originalEmailPublicBaseUrl = config.EMAIL_PUBLIC_BASE_URL;
const originalNodeEnv = config.NODE_ENV;

function override(
  key: PlatformSettingOverride['key'],
  overrideValue: unknown,
  version = 1
): PlatformSettingOverride {
  return {
    key,
    overrideValue,
    version,
    updatedBy: 'admin-subject',
    updatedAt: '2026-07-25T00:00:00.000Z'
  };
}

afterEach(() => {
  mutableConfig.PLATFORM_SETTINGS_POLICY = originalPolicy;
  mutableConfig.PASSWORD_AUTH_ENABLED = originalPasswordAuthEnabled;
  mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = originalPasswordEmailVerificationRequired;
  mutableConfig.EMAIL_PUBLIC_BASE_URL = originalEmailPublicBaseUrl;
  mutableConfig.NODE_ENV = originalNodeEnv;
  applyPlatformSettingOverrides([]);
});

describe('durable platform setting resolution', () => {
  it('uses permitted overrides and constrains a stored discovery mode after policy tightening', () => {
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      memberDiscovery: {
        allowedModes: ['disabled', 'exact_email', 'directory'],
        defaultMode: 'exact_email'
      }
    };
    const stored = override('member_discovery', { mode: 'directory' });
    applyPlatformSettingOverrides([stored]);

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'directory');
    assert.equal(getPlatformSetting('member_discovery').source, 'runtime_override');

    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...mutableConfig.PLATFORM_SETTINGS_POLICY,
      memberDiscovery: {
        allowedModes: ['disabled', 'exact_email'],
        defaultMode: 'exact_email'
      }
    };
    applyPlatformSettingOverrides([stored]);

    const constrained = getPlatformSetting('member_discovery');
    assert.equal(constrained.value.mode, 'exact_email');
    assert.equal(constrained.overrideValue?.mode, 'directory');
    assert.equal(constrained.source, 'runtime_override_constrained');
  });

  it('replaces one cached override without discarding the others', () => {
    applyPlatformSettingOverrides([
      override('member_discovery', { mode: 'disabled' }),
      override('password_signup', { enabled: false })
    ]);

    applyPlatformSettingOverride(override('member_discovery', { mode: 'exact_email' }, 2));

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'exact_email');
    assert.equal(getPlatformSetting('password_signup').version, 1);
  });

  it('does not let a delayed invalidation overwrite a newer cached version', () => {
    applyPlatformSettingOverrides([
      override('member_discovery', { mode: 'exact_email' }, 3)
    ]);

    applyPlatformSettingOverride(override('member_discovery', { mode: 'disabled' }, 2));

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'exact_email');
    assert.equal(getPlatformSetting('member_discovery').version, 3);
  });

  it('does not let a delayed full refresh overwrite a newer cached version', () => {
    applyPlatformSettingOverrides([
      override('member_discovery', { mode: 'exact_email' }, 3),
      override('password_signup', { enabled: false }, 2)
    ]);

    applyRefreshedPlatformSettingOverrides([
      override('member_discovery', { mode: 'disabled' }, 2),
      override('password_signup', { enabled: true }, 3)
    ]);

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'exact_email');
    assert.equal(getPlatformSetting('member_discovery').version, 3);
    assert.equal(getPlatformSetting('password_signup').version, 3);
  });

  it('allows AI policy to narrow but not expand the deployment model ceiling', () => {
    const deployment = getPlatformSetting('ai_policy').deploymentDefault;
    const narrowed = {
      ...deployment,
      providerModels: {
        openai: [deployment.providerModels.openai[0]],
        anthropic: [],
        gemini: []
      },
      defaultProvider: 'openai' as const,
      defaultModel: deployment.providerModels.openai[0],
      reasoningSummaryModes: ['off' as const],
      reasoningEfforts: ['high' as const]
    };

    assert.equal(validatePlatformSettingOverride('ai_policy', narrowed), null);
    applyPlatformSettingOverrides([override('ai_policy', narrowed)]);
    assert.deepEqual(getPlatformSetting('ai_policy').value, narrowed);

    const expanded = {
      ...narrowed,
      providerModels: {
        ...narrowed.providerModels,
        openai: [...narrowed.providerModels.openai, 'unapproved-model']
      }
    };
    assert.match(
      validatePlatformSettingOverride('ai_policy', expanded) || '',
      /cannot expand/
    );
  });

  it('keeps password signup disabled when deployment prerequisites are unavailable', () => {
    mutableConfig.PASSWORD_AUTH_ENABLED = false;
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      passwordSignup: {
        allowedValues: [false, true],
        defaultValue: false
      }
    };
    applyPlatformSettingOverrides([
      override('password_signup', { enabled: true }, 4)
    ]);

    const state = getPlatformSetting('password_signup');
    assert.deepEqual(state.value, { enabled: false });
    assert.deepEqual(state.overrideValue, { enabled: true });
    assert.equal(state.source, 'runtime_override_constrained');
    assert.match(state.warning || '', /Password authentication is disabled/);
    assert.match(
      validatePlatformSettingOverride('password_signup', { enabled: true }) || '',
      /Password authentication is disabled/
    );
  });

  it('resolves the effective reset value through operational constraints', () => {
    mutableConfig.PASSWORD_AUTH_ENABLED = false;
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      passwordSignup: {
        allowedValues: [false, true],
        defaultValue: true
      }
    };

    const resetState = getPlatformSettingWithoutOverride('password_signup');

    assert.deepEqual(resetState.deploymentDefault, { enabled: true });
    assert.deepEqual(resetState.value, { enabled: false });
  });

  it('blocks runtime signup enablement when production verification links are not HTTPS', () => {
    mutableConfig.NODE_ENV = 'production';
    mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = true;
    mutableConfig.EMAIL_PUBLIC_BASE_URL = 'http://accounts.example.com';

    assert.ok(
      passwordSignupOperationalBlockers().includes(
        'Production verification links require an HTTPS external base URL.'
      )
    );
  });
});
