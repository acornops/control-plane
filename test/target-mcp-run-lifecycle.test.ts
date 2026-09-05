import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { resolveReadyInteractiveRunTools } from '../src/controllers/interactive-mcp-availability.js';
import { LlmGatewayHttpError } from '../src/services/mcp-registry-client.js';
import { resolveTargetRunTools } from '../src/services/target-run-tool-resolution.js';
import {
  createResponse,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import { installResolverRepoStubs } from './helpers/target-run-tool-resolution-fixtures.js';

afterEach(restoreControllerRegressionState);

function installLifecycleFence(): void {
  installResolverRepoStubs(['read']);
  mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/internal/mcp/tools?')) {
      return Response.json({ detail: {
        code: 'MCP_LIFECYCLE_FENCED',
        message: 'MCP lifecycle teardown is in progress for this destination.',
        retryable: false
      } }, { status: 409 });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  });
}

describe('target run MCP lifecycle fence', () => {
  it('fails closed when gateway teardown has fenced a still-visible target', async () => {
    installLifecycleFence();

    await assert.rejects(resolveTargetRunTools({
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'virtual_machine',
      toolAccessMode: 'read_only',
      runId: 'run-1'
    }), (error: unknown) => (
      error instanceof LlmGatewayHttpError
      && error.status === 409
      && error.gatewayCode === 'MCP_LIFECYCLE_FENCED'
    ));
  });

  it('returns the stable non-retryable deleting response for interactive target runs', async () => {
    installLifecycleFence();
    const response = createResponse();

    const availability = await resolveReadyInteractiveRunTools(response as never, {
      workspaceId: 'workspace-1',
      targetId: 'target-1',
      targetType: 'virtual_machine',
      toolAccessMode: 'read_only',
      runId: 'run-1',
      principal: { type: 'user', id: 'user-1', membershipGeneration: 1 }
    });

    assert.equal(availability, null);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { error: {
      code: 'MCP_LIFECYCLE_FENCED',
      message: 'This MCP scope is being deleted and is no longer available.',
      retryable: false
    } });
  });
});
