import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.js';
import { isModelAllowedForProvider, parseAllowedProviders } from '../src/services/llm-policy.js';
import {
  applyPlatformSettingOverrides,
  getPlatformSetting,
  getPlatformSettingWithoutOverride,
  parsePlatformSettingValue,
  validatePlatformSettingOverride
} from '../src/services/platform-settings.js';
import type { PlatformSettingOverride } from '../src/store/repository-platform-settings.js';

const originalPolicy = config.PLATFORM_SETTINGS_POLICY;
const originalProviders = config.LLM_PROVIDERS_JSON;
const additions = { openai: ['gpt-future'], anthropic: [], gemini: [] };

function applyPolicy(value: unknown): void {
  const override: PlatformSettingOverride = {
    key: 'ai_policy', overrideValue: value, version: 1,
    updatedBy: 'admin', updatedAt: '2026-10-26T00:00:00.000Z'
  };
  applyPlatformSettingOverrides([override]);
}

function enableAdditions(): void {
  config.PLATFORM_SETTINGS_POLICY = {
    ...originalPolicy, aiPolicy: { ...originalPolicy.aiPolicy, allowAdditionalModels: true }
  };
}

afterEach(() => {
  config.PLATFORM_SETTINGS_POLICY = originalPolicy;
  config.LLM_PROVIDERS_JSON = originalProviders;
  applyPlatformSettingOverrides([]);
});

describe('empty effective AI policies', () => {
  it('fails closed when opt-out removes the only enabled model without resetting admin restrictions', () => {
    enableAdditions();
    const selected = parsePlatformSettingValue('ai_policy', {
      ...getPlatformSetting('ai_policy').deploymentDefault,
      additionalProviderModels: additions,
      defaultProvider: 'openai',
      defaultModel: 'gpt-future',
      providerModels: { openai: ['gpt-future'], anthropic: [], gemini: [] },
      reasoningSummariesEnabled: false,
      reasoningSummaryModes: ['off'],
      reasoningEfforts: ['low']
    });
    assert.equal(validatePlatformSettingOverride('ai_policy', selected), null);
    applyPolicy(selected);

    config.PLATFORM_SETTINGS_POLICY = originalPolicy;
    const constrained = getPlatformSetting('ai_policy');
    assert.equal(constrained.source, 'runtime_override_constrained');
    assert.deepEqual(constrained.value.providerModels, { openai: [], anthropic: [], gemini: [] });
    assert.equal(constrained.value.defaultProvider, 'openai');
    assert.equal(constrained.value.defaultModel, 'gpt-future');
    assert.equal(constrained.value.reasoningSummariesEnabled, false);
    assert.deepEqual(constrained.value.reasoningSummaryModes, ['off']);
    assert.deepEqual(constrained.value.reasoningEfforts, ['low']);
    assert.deepEqual(constrained.value.additionalProviderModels, additions);
    assert.deepEqual(parseAllowedProviders(), []);
    assert.equal(isModelAllowedForProvider('openai', 'gpt-future'), false);
    assert.equal(isModelAllowedForProvider('openai', 'gpt-5.5'), false);
    assert.ok(validatePlatformSettingOverride('ai_policy', constrained.value));

    enableAdditions();
    assert.deepEqual(getPlatformSetting('ai_policy').value, selected);
    assert.equal(isModelAllowedForProvider('openai', 'gpt-future'), true);
    const reset = getPlatformSettingWithoutOverride('ai_policy');
    assert.deepEqual(reset.value, reset.deploymentDefault);
  });

  it('does not re-enable deployment models when a deployment update removes the last selected model', () => {
    config.LLM_PROVIDERS_JSON = JSON.stringify({ openai: ['gpt-5.5', 'retired-model'] });
    const selected = parsePlatformSettingValue('ai_policy', {
      ...getPlatformSetting('ai_policy').deploymentDefault,
      defaultModel: 'retired-model',
      providerModels: { openai: ['retired-model'], anthropic: [], gemini: [] }
    });
    assert.equal(validatePlatformSettingOverride('ai_policy', selected), null);
    applyPolicy(selected);
    config.LLM_PROVIDERS_JSON = JSON.stringify({ openai: ['gpt-5.5'] });

    assert.deepEqual(getPlatformSetting('ai_policy').value.providerModels, { openai: [], anthropic: [], gemini: [] });
    assert.equal(isModelAllowedForProvider('openai', 'gpt-5.5'), false);
  });

  it('rejects a newly submitted AI policy with no enabled models', () => {
    const candidate = parsePlatformSettingValue('ai_policy', {
      ...getPlatformSetting('ai_policy').deploymentDefault,
      providerModels: { openai: [], anthropic: [], gemini: [] }
    });
    assert.ok(validatePlatformSettingOverride('ai_policy', candidate));
  });
});
