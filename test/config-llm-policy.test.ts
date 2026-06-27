import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';
import { flatProviderModels, parseConfiguredAllowedProviderModels } from '../src/config-llm-policy.js';

function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}

describe('LLM provider policy config', () => {
  it('defaults to current assistant-capable models without GPT-4 OpenAI entries', () => {
    const config = parseAppConfig({});
    const providerModels = parseConfiguredAllowedProviderModels(config.LLM_ALLOWED_PROVIDER_MODELS);
    const models = flatProviderModels(providerModels);

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'gpt-5.5');
    assert.equal(config.LLM_ALLOWED_MODELS, '');
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
          LLM_ALLOWED_PROVIDERS: 'openai,anthropic',
          LLM_ALLOWED_PROVIDER_MODELS: '',
          LLM_ALLOWED_MODELS: 'gpt-4.1-mini,gemini-2.0-flash'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_PROVIDER?.length)
    );

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gemini-2.0-flash',
          LLM_ALLOWED_PROVIDERS: 'gemini',
          LLM_ALLOWED_PROVIDER_MODELS: '',
          LLM_ALLOWED_MODELS: 'gpt-4.1-mini'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gemini-2.0-flash',
          LLM_ALLOWED_PROVIDERS: 'unknown',
          LLM_ALLOWED_PROVIDER_MODELS: '',
          LLM_ALLOWED_MODELS: ''
        }),
      (error) => {
        const errors = fieldErrors(error);
        assert.ok(errors.LLM_ALLOWED_PROVIDERS?.length);
        assert.ok(errors.LLM_ALLOWED_MODELS?.length);
        return true;
      }
    );
  });

  it('allows custom model names when provider ownership cannot be inferred', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_ALLOWED_PROVIDERS: 'openai',
      LLM_ALLOWED_PROVIDER_MODELS: '',
      LLM_ALLOWED_MODELS: 'workspace-primary'
    });

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');
  });

  it('allows unclassified custom model names in mixed provider allowlists', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_ALLOWED_PROVIDERS: 'openai',
      LLM_ALLOWED_PROVIDER_MODELS: '',
      LLM_ALLOWED_MODELS: 'gpt-4.1-mini,workspace-primary'
    });

    assert.equal(config.LLM_DEFAULT_PROVIDER, 'openai');
    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gpt-4.1-mini',
          LLM_ALLOWED_PROVIDERS: 'gemini',
          LLM_ALLOWED_PROVIDER_MODELS: '',
          LLM_ALLOWED_MODELS: 'gpt-4.1-mini,workspace-primary'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );
  });

  it('uses provider-scoped model ownership when configured', () => {
    const config = parseAppConfig({
      LLM_DEFAULT_PROVIDER: 'openai',
      LLM_DEFAULT_MODEL: 'workspace-primary',
      LLM_ALLOWED_PROVIDERS: 'openai,gemini',
      LLM_ALLOWED_PROVIDER_MODELS: 'openai:workspace-primary;gemini:workspace-primary'
    });

    assert.equal(config.LLM_DEFAULT_MODEL, 'workspace-primary');

    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'workspace-primary',
          LLM_ALLOWED_PROVIDERS: 'openai,gemini',
          LLM_ALLOWED_PROVIDER_MODELS: 'openai:workspace-primary;gemini:gemini-2.0-flash'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );
  });
});
