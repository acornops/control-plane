import { mock } from 'node:test';
import type { RunEvent } from '../../src/types/domain.js';
import {
  createWorkspaceAiCredentialStatusResponse,
  isWorkspaceAiCredentialStatusRequest
} from './controller-regression-fixtures.js';

export function createRunEvent(type: string, seq: number, payload: Record<string, unknown> = {}): RunEvent {
  return {
    schema_version: 1,
    run_id: 'run-1',
    seq,
    ts: '2026-05-24T00:00:00.000Z',
    type,
    payload
  };
}

const VM_BOOTSTRAP_TOOLS = [
  { name: 'restart_service', server_id: '00000000-0000-4000-8000-000000000001', model_alias: 'restart_service', mcp_server_url: 'http://control-plane:8081/internal/v1/mcp', timeout_ms: 10000, description: 'Restart a VM service', capability: 'write', version: 'v1', source: 'builtin', input_schema: { type: 'object' }, enabled: true },
  { name: 'query_logs', server_id: '00000000-0000-4000-8000-000000000001', model_alias: 'query_logs', mcp_server_url: 'http://control-plane:8081/internal/v1/mcp', timeout_ms: 10000, description: 'Read VM logs', capability: 'read', version: 'v2', source: 'builtin', input_schema: { type: 'object' }, enabled: true }
];

export function mockVmBootstrapToolFetch(): void {
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/tools?')) {
      return new Response(JSON.stringify(VM_BOOTSTRAP_TOOLS), { status: 200 });
    }
    if (isWorkspaceAiCredentialStatusRequest(input)) {
      return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
    }
    return new Response('unexpected request', { status: 500 });
  });
}
