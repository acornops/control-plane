import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runRequestProvenance } from '../src/controllers/run-actor.js';
import { buildPublicOpenApiDocument } from '../src/docs/openapi/public-documents.js';
import { mapWorkflowExecutionSummary } from '../src/store/repository-workflow-activity.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'execution-1',
    workspace_id: 'workspace-1',
    workflow_id: 'workflow-1',
    workflow_version: 3,
    workflow_snapshot: { name: 'Production triage' },
    status: 'running',
    request_actor_type: 'user',
    created_by: 'user-1',
    created_at: '2026-07-15T08:00:00.000Z',
    started_at: '2026-07-15T08:00:03.000Z',
    ended_at: null,
    updated_at: '2026-07-15T08:02:00.000Z',
    root_run_id: 'run-1',
    root_target_id: 'cluster-1',
    root_target_name: 'Payments production',
    root_target_type: 'kubernetes',
    root_requested_at: '2026-07-15T08:00:00.000Z',
    root_started_at: '2026-07-15T08:00:03.000Z',
    root_ended_at: null,
    trigger_type: 'acornops_event',
    trigger_id: 'trigger-1',
    source_id: 'issue-1',
    occurrence_key: 'raw-occurrence-key-must-not-escape',
    ...overrides
  };
}

describe('workflow activity visibility contract', () => {
  it('returns the immutable safe provenance snapshot without occurrence keys', () => {
    const mapped = mapWorkflowExecutionSummary(row({
      origin_snapshot: {
        schemaVersion: 1,
        kind: 'event_trigger',
        label: 'Triage new issues',
        triggerId: 'trigger-1',
        source: {
          kind: 'issue',
          id: 'issue-1',
          label: 'Payments worker is restarting',
          eventType: 'issue.created.v1',
          targetId: 'cluster-1',
          targetType: 'kubernetes'
        }
      }
    }) as never);

    assert.equal(mapped.status, 'running');
    assert.equal(mapped.workflow.name, 'Production triage');
    assert.equal(mapped.rootRun?.targetName, 'Payments production');
    assert.deepEqual(mapped.origin, {
      schemaVersion: 1,
      kind: 'event_trigger',
      label: 'Triage new issues',
      triggerId: 'trigger-1',
      source: {
        kind: 'issue',
        id: 'issue-1',
        label: 'Payments worker is restarting',
        eventType: 'issue.created.v1',
        targetId: 'cluster-1',
        targetType: 'kubernetes'
      }
    });
    assert.equal('occurrenceKey' in mapped.origin, false);
  });

  it('captures the registered external integration name for operator provenance', () => {
    const provenance = runRequestProvenance({
      auth: {
        userId: 'user-1',
        credential: {
          type: 'external_integration',
          linkId: 'link-1',
          integrationId: 'mattermost-eng',
          provider: 'mattermost',
          externalUserId: 'mm-user-1'
        }
      },
      externalIntegrationClient: {
        id: 'mattermost-eng',
        provider: 'mattermost',
        displayName: 'Mattermost',
        sha256: 'a'.repeat(64),
        enabled: true,
        allowedCapabilities: ['read_workspace_data']
      }
    } as never);

    assert.deepEqual(provenance, {
      actorType: 'external_integration',
      externalIntegrationLinkId: 'link-1',
      externalIntegrationClientId: 'mattermost-eng',
      externalIntegrationLabel: 'Mattermost'
    });
  });

  it('publishes the workspace ledger in public OpenAPI', () => {
    const document = buildPublicOpenApiDocument('public');
    assert.ok(document.paths['/api/v1/workspaces/{workspaceId}/workflow-executions']?.get);
    assert.ok(document.components.schemas.WorkflowExecutionOrigin);
    assert.ok(document.components.schemas.WorkflowExecutionPage);
  });
});
