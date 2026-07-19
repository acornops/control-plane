import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  importTargetCatalogMcpServer,
  reimportTargetCatalogMcpServer
} from '../src/controllers/catalog-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function gatewayServer(revision = 1) {
  return {
    id: 'server-1', workspace_id: 'workspace-1', scope_type: 'target',
    target_id: 'cluster-1', target_type: 'kubernetes', server_name: 'Operations',
    server_url: 'https://mcp.example/mcp', enabled: true, auth_type: 'none',
    auth_scope: 'none', credential_configured: false, public_headers: {},
    connection_status: 'ok', last_discovery_at: null, last_discovery_error: null,
    revision, provenance_type: 'catalog', target_constraints: {}, tools: []
  };
}

const catalogBody = {
  artifact: { artifactId: 'artifact-1' },
  version: '1.2.3',
  remoteEndpoint: 'https://mcp.example/mcp'
};

describe('target catalog controllers', () => {
  it('derives target type and workspace ownership on import and reimport', async () => {
    installWorkspace('admin');
    const gatewayBodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([gatewayServer()]), { status: 200 });
      }
      gatewayBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(gatewayServer(gatewayBodies.length)), { status: gatewayBodies.length === 1 ? 201 : 200 });
    });

    const imported = await callController(importTargetCatalogMcpServer, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      { ...catalogBody, targetType: 'virtual_machine' }
    ));
    const reimported = await callController(reimportTargetCatalogMcpServer, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'server-1' },
      { ...catalogBody, expectedRevision: 1, targetType: 'virtual_machine' }
    ));

    assert.equal(imported.statusCode, 201);
    assert.equal(reimported.statusCode, 200);
    assert.deepEqual(gatewayBodies.map((body) => ({
      scopeType: body.scope_type,
      targetId: body.target_id,
      targetType: body.target_type,
      reimportServerId: body.reimport_server_id,
      expectedRevision: body.expected_revision
    })), [
      { scopeType: 'target', targetId: 'cluster-1', targetType: 'kubernetes', reimportServerId: undefined, expectedRevision: undefined },
      { scopeType: 'target', targetId: 'cluster-1', targetType: 'kubernetes', reimportServerId: 'server-1', expectedRevision: 1 }
    ]);
  });

  it('rejects Agent constraints and missing target ownership before gateway import', async () => {
    installWorkspace('admin');
    const getInstalledTarget = repo.getTarget;
    repo.getTarget = async (workspaceId, targetId) => workspaceId === 'workspace-1'
      ? getInstalledTarget(workspaceId, targetId)
      : null;
    const gatewayFetch = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(gatewayServer()), { status: 201 }));

    const constrained = await callController(importTargetCatalogMcpServer, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      { ...catalogBody, targetConstraints: { targetIds: ['cluster-1'] } }
    ));
    const wrongWorkspace = await callController(importTargetCatalogMcpServer, createRequest(
      { workspaceId: 'workspace-2', targetId: 'cluster-1' },
      catalogBody
    ));

    assert.equal(constrained.statusCode, 400);
    assert.equal((constrained.body as { error: { code: string } }).error.code, 'CATALOG_REQUEST_INVALID');
    assert.equal(wrongWorkspace.statusCode, 404);
    assert.equal(gatewayFetch.mock.callCount(), 0);
  });
});
