import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { parseAppConfig } from '../src/config.js';

function fieldErrors(error: unknown): Record<string, string[] | undefined> {
  assert.ok(error instanceof ZodError);
  return error.flatten().fieldErrors;
}

describe('LLM provider policy config', () => {
  it('rejects inconsistent provider policy defaults before run creation', () => {
    assert.throws(
      () =>
        parseAppConfig({
          LLM_DEFAULT_PROVIDER: 'gemini',
          LLM_DEFAULT_MODEL: 'gemini-2.0-flash',
          LLM_ALLOWED_PROVIDERS: 'openai,anthropic',
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
          LLM_ALLOWED_MODELS: 'gpt-4.1-mini,workspace-primary'
        }),
      (error) => Boolean(fieldErrors(error).LLM_DEFAULT_MODEL?.length)
    );
  });
});
