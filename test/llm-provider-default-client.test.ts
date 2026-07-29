import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  deleteDefaultProviderCredential,
  listDefaultProviderCredentials,
  putDefaultProviderCredential
} from '../src/services/llm-provider-credential-client.js';
import {
  adminLlmProviderDefaultDeleteSchema,
  adminLlmProviderDefaultUpsertSchema
} from '../src/types/contracts.js';

afterEach(() => mock.restoreAll());

describe('platform default LLM provider credential client', () => {
  it('uses fixed gateway routes and never returns key material', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return new Response(JSON.stringify({
        providers: [
          { provider: 'openai', configured: true, enabled: true, source: 'platform_default' },
          { provider: 'anthropic', configured: false, enabled: true, source: 'none' },
          { provider: 'gemini', configured: false, enabled: true, source: 'none' }
        ]
      }), { status: 200 });
    });

    const listed = await listDefaultProviderCredentials();
    await putDefaultProviderCredential('anthropic', 'write-only-key');
    await deleteDefaultProviderCredential('gemini');

    assert.deepEqual(
      requests.map(({ url, method }) => [new URL(url).pathname, method]),
      [
        ['/api/v1/internal/llm/default-provider-credentials', 'GET'],
        ['/api/v1/internal/llm/default-provider-credentials/anthropic', 'PUT'],
        ['/api/v1/internal/llm/default-provider-credentials/gemini', 'DELETE']
      ]
    );
    assert.deepEqual(requests[1].body, { api_key: 'write-only-key' });
    assert(!JSON.stringify(listed).includes('write-only-key'));
  });

  it('requires bounded write-only keys and audit reasons', () => {
    assert.equal(adminLlmProviderDefaultUpsertSchema.safeParse({
      apiKey: 'provider-key',
      reason: 'Rotate default'
    }).success, true);
    assert.equal(adminLlmProviderDefaultUpsertSchema.safeParse({
      apiKey: '',
      reason: 'Rotate default'
    }).success, false);
    assert.equal(adminLlmProviderDefaultDeleteSchema.safeParse({
      reason: 'Delete default'
    }).success, true);
  });
});
