import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';
import { flatProviderModels, parseConfiguredProvidersJson } from '../src/config-llm-policy.js';

function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}

describe('LLM provider policy config', () => {
  it('defaults to current assistant-capable models without GPT-4 OpenAI entries', () => {
    const config = parseAppConfig({});
    const providerModels = parseConfiguredProvidersJson(config.LLM_PROVIDERS_JSON);
    const models = flatProviderModels(providerModels);

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'gpt-5.5');
    assert.equal(config.LLM_ALLOWED_REASONING_EFFORTS, 'off,low,medium,high');
    assert(models.includes('gpt-5.5'));
    assert(models.includes('gpt-5.4'));
    assert(models.includes('gpt-5.4-mini'));
    assert(models.includes('gpt-5.4-nano'));
    assert(models.includes('gpt-5'));
    assert(models.includes('gpt-5-mini'));
    assert(models.includes('gpt-5-nano'));
    assert(models.includes('claude-fable-5'));
    assert(models.includes('claude-opus-4-8'));
    assert(models.includes('claude-sonnet-4-6'));
    assert(models.includes('claude-haiku-4-5'));
    assert(models.includes('gemini-3.5-flash'));
    assert(models.includes('gemini-3.5-flash-lite'));
    assert(models.includes('gemini-3.1-pro'));
    assert(models.includes('gemini-3.1-flash'));
    assert(models.includes('gemini-3.1-flash-lite'));
    assert(models.includes('gemini-2.5-pro'));
    assert(models.includes('gemini-2.5-flash'));
    assert(models.includes('gemini-2.5-flash-lite'));
    assert(models.includes('gemini-2.0-flash'));
    assert(models.includes('gemini-2.0-flash-lite'));
    assert.equal(models.some((model) => model.startsWith('gpt-4')), false);
    assert.deepEqual(providerModels.openai, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano']);
    assert.deepEqual(providerModels.anthropic, ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    assert.deepEqual(providerModels.gemini, [
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-pro',
      'gemini-3.1-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite'
    ]);
  });

  it('rejects inconsistent provider policy defaults before run creation', () => {
    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gemini-2.0-flash',
          LLM_PROVIDERS_JSON: JSON.stringify({
            openai: ['gpt-5.5'],
            anthropic: ['claude-sonnet-4-6']
          })
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_PROVIDER?.length)
    );

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gemini-2.0-flash',
          LLM_PROVIDERS_JSON: JSON.stringify({
            gemini: ['gemini-2.5-flash']
          })
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );
  });

  it('rejects malformed or invalid provider maps', () => {
    for (const providersJson of [
      '{',
      '{}',
      '{"unknown":["model"]}',
      '{"openai":[]}',
      '{"openai":["gpt-5.5","gpt-5.5"]}',
      '{"openai":[""]}'
    ]) {
      assert.throws(
        () =>
          parseAppConfig({
            LLM_PROVIDERS_JSON: providersJson
          }),
        (error) => Boolean(fieldErrors(error).LLM_PROVIDERS_JSON?.length)
      );
    }
  });

  it('rejects non-array provider model values', () => {
    assert.throws(
      () =>
        parseAppConfig({
          LLM_PROVIDERS_JSON: '{"openai":"gpt-5.5"}'
        }),
      (error) => Boolean(fieldErrors(error).LLM_PROVIDERS_JSON?.length)
    );
  });

  it('rejects removed provider policy variables instead of silently widening policy', () => {
    assert.throws(
      () =>
        parseAppConfig({
          LLM_ALLOWED_PROVIDERS: 'openai',
          LLM_ALLOWED_PROVIDER_MODELS: 'openai:gpt-5.5'
        }),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.LLM_ALLOWED_PROVIDERS?.length);
        assert.ok(errors.LLM_ALLOWED_PROVIDER_MODELS?.length);
        return true;
      }
    );
  });

  it('allows custom model names when assigned to a provider', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_PROVIDERS_JSON: '{"openai":["workspace-primary"]}'
    });

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');
  });

  it('derives allowed providers from configured provider keys', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_PROVIDERS_JSON: '{"openai":["workspace-primary"],"gemini":["workspace-primary"]}'
    });
    const providerModels = parseConfiguredProvidersJson(config.LLM_PROVIDERS_JSON);

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');
    assert.deepEqual(providerModels.openai, ['workspace-primary']);
    assert.deepEqual(providerModels.anthropic, []);
    assert.deepEqual(providerModels.gemini, ['workspace-primary']);
  });

  it('uses provider-scoped model ownership when configured', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_PROVIDERS_JSON: '{"openai":["workspace-primary"],"gemini":["workspace-primary"]}'
    });

    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'workspace-primary',
          LLM_PROVIDERS_JSON: '{"openai":["workspace-primary"],"gemini":["gemini-2.0-flash"]}'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );
  });
});
