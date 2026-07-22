import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { replaceExternalIntegrationLinkGrants } from '../src/controllers/external-integration-link-controller.js';
import { repo } from '../src/store/repository.js';

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe('external integration link grant management', () => {
  it('returns refreshed granted workspace capabilities after grant updates', async () => {
    mock.method(repo, 'listExternalIntegrationUserLinks', async () => [{
      id: 'link-1',
      integrationClientId: 'dev-client',
      provider: 'external',
      clientDisplayName: 'Development external integration',
      externalUserId: 'user-1',
      linkedAt: '2026-06-08T00:00:00.000Z',
      lastAuthenticatedAt: '2026-06-08T00:00:00.000Z',
      expiresAt: '2026-07-08T00:00:00.000Z',
      grants: []
    }]);
    mock.method(repo, 'listExternalIntegrationGrantableWorkspaces', async () => [{
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      role: 'operator',
      grantedCapabilities: []
    }]);
    mock.method(repo, 'replaceExternalIntegrationWorkspaceGrants', async () => [{
      workspaceId: 'workspace-1',
      capabilities: ['read_workspace_data', 'create_sessions'],
      grantedByUserId: 'user-1',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    }]);
    mock.method(repo, 'insertAccountAuditEvent', async () => undefined);
    const res = createResponse();

    await replaceExternalIntegrationLinkGrants({
      auth: { userId: 'user-1', credential: { type: 'session', sessionId: 'session-1' } },
      params: { linkId: 'link-1' },
      body: {
        workspaceGrants: [{
          workspaceId: 'workspace-1',
          capabilities: ['read_workspace_data', 'create_sessions']
        }]
      }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      (res.body as { link: { grantableWorkspaces: Array<{ grantedCapabilities: string[] }> } }).link.grantableWorkspaces[0].grantedCapabilities,
      ['read_workspace_data', 'create_sessions']
    );
  });
});
