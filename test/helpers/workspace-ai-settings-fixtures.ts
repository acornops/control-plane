import assert from 'node:assert/strict';
import { mock } from 'node:test';
import {
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest
} from './controller-regression-fixtures.js';

export function installAiCredentialGateway(status: 'configured' | 'missing' | 'disabled' = 'configured'): void {
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/llm/provider-credentials/') && init?.method === 'PUT') {
      assert.equal(JSON.parse(String(init.body)).api_key, 'test-key');
      return new Response(JSON.stringify({ provider: 'gemini', configured: true, enabled: true }), { status: 200 });
    }
    if (url.includes('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ provider: 'gemini', configured: false, enabled: true }), { status: 200 });
    }
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      const response = createWorkspaceAiCredentialStatusResponse();
      if (status === 'missing') {
        response.providers = response.providers.map((provider) => ({ ...provider, configured: false }));
      }
      if (status === 'disabled') {
        response.providers = response.providers.map((provider) => (
          provider.provider === 'gemini' ? { ...provider, enabled: false } : provider
        ));
      }
      return new Response(JSON.stringify(response), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}

export function installFailingAiCredentialGateway(): void {
  mock.method(globalThis, 'fetch', async (input) => {
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      return new Response(JSON.stringify({ detail: 'gateway unavailable' }), { status: 503 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}
