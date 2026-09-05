import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapGatewayError } from '../src/controllers/workspaces/common.js';
import { LlmGatewayHttpError } from '../src/services/mcp-registry-client.js';

describe('MCP gateway error mapping', () => {
  it('preserves the recoverable interrupted-cleanup state without exposing internals', () => {
    const mapped = mapGatewayError(new LlmGatewayHttpError(
      503,
      'MCP credential cleanup did not complete; retry this update',
      '{"detail":"MCP credential cleanup did not complete; retry this update"}'
    ));

    assert.equal(mapped.status, 503);
    assert.deepEqual(mapped.body, {
      error: {
        code: 'MCP_CREDENTIAL_CLEANUP_INCOMPLETE',
        message: 'MCP connection settings were saved, but credential cleanup is incomplete',
        retryable: true
      }
    });
  });

  it('keeps unrelated gateway outages generic', () => {
    const mapped = mapGatewayError(new LlmGatewayHttpError(
      503,
      'vault unavailable',
      'vault unavailable'
    ));

    assert.equal(mapped.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(mapped.body.error.message, 'MCP credential service is unavailable');
  });

  it('preserves lifecycle fence identity without exposing gateway detail', () => {
    const mapped = mapGatewayError(new LlmGatewayHttpError(
      409,
      'MCP lifecycle teardown is in progress for this destination.',
      '{}',
      undefined,
      'MCP_LIFECYCLE_FENCED'
    ));

    assert.deepEqual(mapped, {
      status: 409,
      body: { error: {
        code: 'MCP_LIFECYCLE_FENCED',
        message: 'This MCP scope is being deleted and is no longer available.',
        retryable: false
      } }
    });
  });

  it('maps retryable lifecycle teardown failure to the controller-specific safe message', () => {
    const mapped = mapGatewayError(new LlmGatewayHttpError(
      503,
      'MCP lifecycle teardown did not complete; retry the request.',
      '{}',
      undefined,
      'MCP_LIFECYCLE_TEARDOWN_FAILED'
    ), { upstreamMessage: 'Failed to clean up target MCP state with llm-gateway' });

    assert.deepEqual(mapped, {
      status: 503,
      body: { error: {
        code: 'MCP_LIFECYCLE_TEARDOWN_FAILED',
        message: 'Failed to clean up target MCP state with llm-gateway',
        retryable: true
      } }
    });
  });
});
