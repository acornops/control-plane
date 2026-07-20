import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  deleteWorkspaceCatalogSource,
  synchronizeWorkspaceCatalogSource,
  updateWorkspaceCatalogSource
} from '../src/controllers/catalog-sources-controller.js';
import { createWorkspaceCatalogSource } from '../src/controllers/catalog-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

function gatewaySource(enabled = true) {
  return {
    id: 'source-1',
    workspace_id: 'workspace-1',
    display_name: 'Internal MCP Registry',
    base_url: 'https://registry.internal.example',
    auth_type: 'bearer_token',
    credential_configured: true,
    network_route: 'direct',
    enabled,
    management_mode: 'workspace',
    bindings: [{
      id: 'binding-1',
      artifact_kind: 'mcp_server',
      adapter_type: 'mcp_registry_v0_1',
      adapter_base_path: '/v0.1',
      sync_status: 'ready'
    }]
  };
}

function captureAuditEvents(): string[] {
  const eventTypes: string[] = [];
  repo.insertWorkspaceAuditEvent = async (event) => {
    eventTypes.push(event.eventType);
    return {
      id: `audit-${eventTypes.length}`,
      workspaceId: event.workspaceId,
      category: event.category,
      eventType: event.eventType,
      actor: { type: 'user', userId: event.actorUserId },
      object: { type: event.objectType, id: event.objectId },
      summary: event.summary,
      metadata: event.metadata ?? {},
      occurredAt: '2026-07-17T00:00:00.000Z'
    };
  };
  return eventTypes;
}

describe('MCP registry lifecycle controllers', () => {
  it('disables a source without sending authentication and emits update lifecycle audits', async () => {
    installWorkspace('admin');
    const eventTypes = captureAuditEvents();
    let gatewayBody: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_input, init) => {
      gatewayBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(gatewaySource(false)), { status: 200 });
    });

    const response = await callController(
      updateWorkspaceCatalogSource,
      createRequest(
        { workspaceId: 'workspace-1', sourceId: 'source-1' },
        { enabled: false }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.equal(gatewayBody.enabled, false);
    assert.equal('auth' in gatewayBody, false);
    assert.deepEqual(eventTypes, [
      'workspace.catalog_source_updated.v1',
      'workspace.catalog_source_disabled.v1'
    ]);
  });

  it('rejects unavailable routing and incomplete credential replacement before gateway calls', async () => {
    installWorkspace('admin');
    const gateway = mock.method(globalThis, 'fetch', async () => {
      throw new Error('gateway must not be called');
    });

    const connector = await callController(
      updateWorkspaceCatalogSource,
      createRequest(
        { workspaceId: 'workspace-1', sourceId: 'source-1' },
        { networkRoute: 'connector' }
      )
    );
    const missingCredential = await callController(
      updateWorkspaceCatalogSource,
      createRequest(
        { workspaceId: 'workspace-1', sourceId: 'source-1' },
        { auth: { type: 'bearer_token' } }
      )
    );
    const unknownField = await callController(
      updateWorkspaceCatalogSource,
      createRequest(
        { workspaceId: 'workspace-1', sourceId: 'source-1' },
        { enabled: true, ignored: true }
      )
    );
    const malformedCreate = await callController(
      createWorkspaceCatalogSource,
      createRequest(
        { workspaceId: 'workspace-1' },
        { displayName: 'Registry', baseUrl: 'https://registry.example', enabled: 'yes' }
      )
    );

    assert.equal(connector.statusCode, 400);
    assert.equal(missingCredential.statusCode, 400);
    assert.equal(unknownField.statusCode, 400);
    assert.equal(malformedCreate.statusCode, 400);
    assert.equal(gateway.mock.callCount(), 0);
  });

  it('synchronizes and deletes workspace sources with distinct audit events', async () => {
    installWorkspace('admin');
    const eventTypes = captureAuditEvents();
    const methods: string[] = [];
    mock.method(globalThis, 'fetch', async (_input, init) => {
      methods.push(init?.method || 'GET');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ artifact_count: 4 }), { status: 200 });
    });

    const synchronized = await callController(
      synchronizeWorkspaceCatalogSource,
      createRequest({ workspaceId: 'workspace-1', sourceId: 'source-1' })
    );
    const deleted = await callController(
      deleteWorkspaceCatalogSource,
      createRequest({ workspaceId: 'workspace-1', sourceId: 'source-1' })
    );

    assert.equal(synchronized.statusCode, 200);
    assert.deepEqual(synchronized.body, { artifactCount: 4 });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(methods, ['POST', 'DELETE']);
    assert.deepEqual(eventTypes, [
      'workspace.catalog_source_synchronized.v1',
      'workspace.catalog_source_deleted.v1'
    ]);
  });

  it('denies users without source-management capability before gateway calls', async () => {
    installWorkspace('viewer');
    const gateway = mock.method(globalThis, 'fetch', async () => {
      throw new Error('gateway must not be called');
    });

    const response = await callController(
      synchronizeWorkspaceCatalogSource,
      createRequest({ workspaceId: 'workspace-1', sourceId: 'source-1' })
    );

    assert.equal(response.statusCode, 403);
    assert.equal(gateway.mock.callCount(), 0);
  });
});
