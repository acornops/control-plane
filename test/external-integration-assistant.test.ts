import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createSession, postMessage } from '../src/controllers/sessions-controller.js';
import { repo } from '../src/store/repository.js';
import type { ChatSession } from '../src/types/domain.js';
import {
  callController,
  createExternalIntegrationRequest,
  createMessage,
  createRun,
  createSessionRecord,
  createWorkspaceAiCredentialStatusResponse,
  installWorkspace,
  isWorkspaceAiCredentialStatusRequest,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('external integration assistant access', () => {
  it('allows external integration credentials to use read-only VM assistant sessions', async () => {
    installWorkspace('operator');
    repo.getCluster = async () => {
      throw new Error('VM assistant route should not require Kubernetes cluster lookup');
    };
    repo.addSession = async (_workspaceId, targetId) =>
      createSessionRecord({ targetId, targetType: 'virtual_machine', clusterId: undefined });

    const session = await callController(
      createSession,
      createExternalIntegrationRequest({ workspaceId: 'workspace-1', targetId: 'target-1' }, { title: 'VM Session' })
    );

    assert.equal(session.statusCode, 201);
    assert.equal((session.body as ChatSession).targetType, 'virtual_machine');

    repo.getSession = async () =>
      createSessionRecord({ targetId: 'target-1', targetType: 'virtual_machine', clusterId: undefined });
    repo.createRunFromUserMessage = async () => ({
      message: createMessage(),
      run: createRun({
        targetId: 'target-1',
        targetType: 'virtual_machine',
        clusterId: undefined,
        toolAccessMode: 'read_only'
      }),
      idempotent: true
    });
    mock.method(globalThis, 'fetch', async (input) => {
      if (isWorkspaceAiCredentialStatusRequest(input)) {
        return new Response(JSON.stringify(createWorkspaceAiCredentialStatusResponse()), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const message = await callController(
      postMessage,
      createExternalIntegrationRequest({ sessionId: 'session-1' }, { content: 'diagnose vm', toolAccessMode: 'read_only' })
    );

    assert.equal(message.statusCode, 202);
  });
});
