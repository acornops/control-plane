import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { config } from '../src/config.js';
import { postMessage } from '../src/controllers/sessions-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController, createMessage, createRequest, createRun, createSessionRecord,
  createWorkspaceAiCredentialStatusResponse, installMcpUserPrincipal, installWorkspace,
  isWorkspaceAiCredentialStatusRequest, restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const originalDispatchEnabled = config.WORKSPACE_DISPATCH_ENABLED;
const originalDistributedRouting = config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED;
const draining = { error: { code: 'SERVICE_DRAINING', message: 'Service is draining', retryable: true, outcome: 'not_started' } };

beforeEach(() => {
  installMcpUserPrincipal();
  installWorkspace('admin');
  config.WORKSPACE_DISPATCH_ENABLED = false;
  config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = false;
  repo.getSession = async () => createSessionRecord();
  repo.findRunByClientMessageId = async () => null;
  repo.getTargetAgentRegistration = async () => null;
  repo.listTargetToolOverrides = async () => ({});
  mock.method(repo, 'enqueueWebhookOutboxEvent', async () => null);
});
afterEach(() => {
  config.WORKSPACE_DISPATCH_ENABLED = originalDispatchEnabled;
  config.CONTROL_PLANE_DISTRIBUTED_ROUTING_ENABLED = originalDistributedRouting;
  restoreControllerRegressionState();
});

for (const recover of [true, false]) {
  test(`fresh message ${recover ? 'creates one run after gateway drain recovery' : 'creates no run on an ordinary gateway 503'}`, async () => {
    let credentialReads = 0;
    const creations: Array<Parameters<typeof repo.createRunFromUserMessage>[0]> = [];
    repo.createRunFromUserMessage = async (input) => {
      creations.push(input);
      return { message: createMessage(), run: createRun(), idempotent: false };
    };
    mock.method(globalThis, 'fetch', async (input, init) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        credentialReads++;
        assert.equal(creations.length, 0);
        assert.equal(init.method, 'GET');
        if (credentialReads === 1) {
          return new Response(JSON.stringify(recover ? draining : { detail: 'gateway unavailable' }), { status: 503 });
        }
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()));
      }
      if (String(input).includes('/api/v1/internal/mcp/tools?')) return new Response(JSON.stringify([{
        name: 'list_pods', server_id: 'builtin-target', source: 'builtin', enabled: true,
        capability: 'read', input_schema: { type: 'object' }
      }]));
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    const response = await callController(postMessage, createRequest(
      { sessionId: 'session-1' },
      { content: 'diagnose', toolAccessMode: 'read_write', clientMessageId: 'fresh-message' }
    ));

    assert.equal(response.statusCode, recover ? 202 : 503);
    assert.equal(credentialReads, recover ? 2 : 1);
    assert.equal(creations.length, recover ? 1 : 0);
    if (recover) {
      assert.equal(creations[0].clientMessageId, 'fresh-message');
      assert.equal((response.body as { run_id: string }).run_id, 'run-1');
      assert.equal((response.body as { message_id: string }).message_id, 'message-1');
    }
  });
}
