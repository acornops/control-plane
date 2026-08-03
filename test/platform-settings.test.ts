import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import {
  applyPlatformSettingOverride,
  applyPlatformSettingOverrides,
  applyRefreshedPlatformSettingOverrides,
  getPlatformSetting,
  getPlatformSettingWithoutOverride,
  parsePlatformSettingValue,
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
      override('user_sign_in_methods', { methods: ['oidc'] })
    ]);

    applyPlatformSettingOverride(override('member_discovery', { mode: 'exact_email' }, 2));

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'exact_email');
    assert.equal(getPlatformSetting('user_sign_in_methods').version, 1);
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
      override('user_sign_in_methods', { methods: ['oidc'] }, 2)
    ]);

    applyRefreshedPlatformSettingOverrides([
      override('member_discovery', { mode: 'disabled' }, 2),
      override('user_sign_in_methods', { methods: ['password'] }, 3)
    ]);

    assert.equal(getPlatformSetting('member_discovery').value.mode, 'exact_email');
    assert.equal(getPlatformSetting('member_discovery').version, 3);
    assert.equal(getPlatformSetting('user_sign_in_methods').version, 3);
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

  it('constrains disabled methods and preserves legacy signup overrides without changing access', () => {
    mutableConfig.PASSWORD_AUTH_ENABLED = false;
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      userSignInMethods: {
        allowedMethods: ['oidc'],
        defaultMethods: ['oidc']
      }
    };
    applyPlatformSettingOverrides([
      override('password_signup', { enabled: true }, 4)
    ]);

    const state = getPlatformSetting('user_sign_in_methods');
    assert.deepEqual(state.value, { methods: ['oidc'] });
    assert.deepEqual(state.overrideValue, { methods: ['oidc'] });
    assert.equal(state.source, 'runtime_override_constrained');
    assert.match(state.warning || '', /legacy password signup/);
    assert.match(
      validatePlatformSettingOverride('user_sign_in_methods', { methods: ['password'] }) || '',
      /fixed by the deployment policy/
    );
  });

  it('requires at least one permitted sign-in method', () => {
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      userSignInMethods: {
        allowedMethods: ['password', 'oidc'],
        defaultMethods: ['password', 'oidc']
      }
    };

    assert.match(
      validatePlatformSettingOverride('user_sign_in_methods', { methods: [] }) || '',
      /At least one/
    );
  });

  it('uses product help-link defaults and accepts only bounded safe overrides', () => {
    const initial = getPlatformSetting('help_links');
    assert.deepEqual(initial.value, {
      documentationUrl: 'https://docs.acornops.dev',
      supportUrl: 'https://discord.gg/jBgTy4KhF'
    });
    assert.equal(initial.source, 'deployment_default');

    const custom = {
      documentationUrl: 'https://docs.example.com/platform',
      supportUrl: 'mailto:support@example.com'
    };
    assert.deepEqual(parsePlatformSettingValue('help_links', custom), custom);
    assert.equal(validatePlatformSettingOverride('help_links', custom), null);
    applyPlatformSettingOverrides([override('help_links', custom, 2)]);
    assert.deepEqual(getPlatformSetting('help_links').value, custom);
    assert.equal(getPlatformSetting('help_links').source, 'runtime_override');

    assert.throws(() => parsePlatformSettingValue('help_links', {
      documentationUrl: 'javascript:alert(1)',
      supportUrl: 'https://support.example.com'
    }));
    assert.throws(() => parsePlatformSettingValue('help_links', {
      documentationUrl: 'https://user:secret@docs.example.com',
      supportUrl: 'mailto:support@example.com?subject=unsafe'
    }));
  });

  it('merges Helm Kubernetes RBAC profiles with additive admin overrides', () => {
    const cnpg = {
        key: 'cnpg',
        name: 'CNPG',
        description: 'CloudNativePG clusters',
        resources: [{
          apiGroup: 'postgresql.cnpg.io',
          apiVersion: 'v1',
          resource: 'clusters',
          kind: 'Cluster',
          scope: 'namespaced' as const,
          verbs: ['list', 'patch'] as const
        }]
    };
    const mongodb = {
      ...cnpg,
      key: 'mongodb',
      name: 'MongoDB',
      resources: [{ ...cnpg.resources[0], apiGroup: 'mongodbcommunity.mongodb.com', resource: 'mongodbcommunity', kind: 'MongoDBCommunity', verbs: ['list'] as const }]
    };
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      kubernetesRbacAdditions: { runtimeEditable: true, profiles: [cnpg] }
    };
    const overlay = { upserts: [mongodb], disabledKeys: ['cnpg'] };

    assert.equal(validatePlatformSettingOverride('kubernetes_rbac_additions', overlay), null);
    applyPlatformSettingOverrides([override('kubernetes_rbac_additions', overlay, 7)]);
    const state = getPlatformSetting('kubernetes_rbac_additions');
    assert.deepEqual(state.deploymentDefault.additions, [cnpg]);
    assert.deepEqual(state.value.additions, [mongodb]);
    assert.deepEqual(state.overrideValue, overlay);
    assert.equal(state.version, 7);

    applyPlatformSettingOverrides([override('kubernetes_rbac_additions', {
      upserts: [{ ...cnpg, resources: [{ ...cnpg.resources[0], verbs: ['patch'] }] }],
      disabledKeys: []
    }, 8)]);
    const ignored = getPlatformSetting('kubernetes_rbac_additions');
    assert.deepEqual(ignored.value, { additions: [cnpg] });
    assert.match(ignored.warning || '', /invalid and were ignored/);
  });

  it('normalizes the original whole-catalog mutation without hiding future Helm additions', () => {
    const legacy = { additions: [{
      key: 'cnpg', name: 'CNPG', description: '',
      resources: [{
        apiGroup: 'postgresql.cnpg.io', apiVersion: 'v1', resource: 'clusters', kind: 'Cluster',
        scope: 'namespaced' as const, verbs: ['list'] as const
      }]
    }] };

    assert.deepEqual(parsePlatformSettingValue('kubernetes_rbac_additions', legacy), {
      upserts: legacy.additions,
      disabledKeys: []
    });
  });

  it('lets deployment policy make the Kubernetes RBAC catalog read-only', () => {
    mutableConfig.PLATFORM_SETTINGS_POLICY = {
      ...originalPolicy,
      kubernetesRbacAdditions: { runtimeEditable: false, profiles: [] }
    };
    applyPlatformSettingOverrides([]);

    const state = getPlatformSetting('kubernetes_rbac_additions');
    assert.equal(state.editable, false);
    assert.match(
      validatePlatformSettingOverride('kubernetes_rbac_additions', { upserts: [], disabledKeys: [] }) || '',
      /fixed by the deployment policy/
    );
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
