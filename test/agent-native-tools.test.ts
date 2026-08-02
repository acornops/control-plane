import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { setAgentNativeToolAssignment } from '../src/services/agent-native-tools.js';
import { computeWorkflowReadiness } from '../src/services/automation-readiness.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../src/store/repository-capability-routing.js';
import { getWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures();
});
after(closeAutomationDatabaseFixtures);

describe('Agent workspace-native tool assignments', () => {
  it('atomically grants, updates, and clears normalized Fetch configuration', async () => {
    const before = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(before);

    const granted = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'http.fetch.get',
      assigned: true,
      actorUserId: 'user-1',
      config: {
        allowedUrlPatterns: [
          'https://STATUS.Example.com:443/api/*',
          'https://api.example.com/search?q=*'
        ]
      }
    });
    assert.deepEqual(granted.nativeToolConfigs['http.fetch.get'], {
      allowedUrlPatterns: [
        'https://api.example.com/search?q=*',
        'https://status.example.com/api/*'
      ]
    });
    assert.ok(granted.tools.includes('http.fetch.get'));
    const grantedMapping = (await listCapabilityRoutingMappings('workspace-1'))
      .find((mapping) => mapping.id === `native:${before.id}:http.fetch.get`);
    assert.ok(grantedMapping);

    const updated = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'http.fetch.get',
      assigned: true,
      actorUserId: 'user-1',
      config: { allowedUrlPatterns: ['https://status.example.com/health'] }
    });
    assert.deepEqual(updated.nativeToolConfigs['http.fetch.get'], {
      allowedUrlPatterns: ['https://status.example.com/health']
    });
    const updatedMapping = (await listCapabilityRoutingMappings('workspace-1'))
      .find((mapping) => mapping.id === `native:${before.id}:http.fetch.get`);
    assert.equal(updatedMapping?.reviewState, 'reviewed');

    const revoked = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'http.fetch.get',
      assigned: false,
      actorUserId: 'user-1'
    });
    assert.equal(revoked.nativeToolConfigs['http.fetch.get'], undefined);
    assert.equal(revoked.tools.includes('http.fetch.get'), false);
  });

  it('requires valid Fetch configuration without changing bodyless grants for other tools', async () => {
    const agent = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(agent);
    await assert.rejects(() => setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: agent.id,
      toolId: 'http.fetch.get',
      assigned: true,
      actorUserId: 'user-1'
    }), /configuration must be an object/);
    await assert.doesNotReject(() => setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: agent.id,
      toolId: 'documents.create',
      assigned: true,
      actorUserId: 'user-1'
    }));
  });

  it('updates reviewed mappings while refreshing dependent readiness', async () => {
    const before = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(before);

    const granted = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'documents.create',
      assigned: true,
      actorUserId: 'user-1'
    });
    assert.ok(granted.tools.includes('documents.create'));
    assert.ok(granted.semanticCapabilityIds.includes('documents.create'));
    assert.equal(granted.readiness.status, 'ready');

    const afterGrantMappings = (await listCapabilityRoutingMappings('workspace-1'))
      .filter((mapping) => mapping.agentId === before.id);
    const nativeMapping = afterGrantMappings.find((mapping) => mapping.nativeToolIds.includes('documents.create'));
    assert.ok(nativeMapping);
    assert.equal(nativeMapping.reviewState, 'reviewed');

    await db.query(
      `UPDATE capability_routing_mappings SET review_state='draft',reviewed_by=NULL
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', nativeMapping.id]
    );
    const coordinatedReadiness = await computeWorkflowReadiness({
      ...(await getWorkflowDefinition('workspace-1', 'cluster-triage'))!,
      agentIds: [before.id, 'agent-incident-reporter'],
      executionMode: 'coordinated'
    });
    assert.deepEqual(coordinatedReadiness, { status: 'ready', reasons: [] });

    const dependentAfterGrant = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.equal(dependentAfterGrant?.readiness.status, 'ready');

    const revoked = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'documents.create',
      assigned: false,
      actorUserId: 'user-1'
    });
    assert.equal(revoked.tools.includes('documents.create'), false);
    assert.equal(revoked.semanticCapabilityIds.includes('documents.create'), false);
    assert.equal(revoked.readiness.status, 'ready');

    const afterRevokeMappings = (await listCapabilityRoutingMappings('workspace-1'))
      .filter((mapping) => mapping.agentId === before.id);
    assert.equal(
      afterRevokeMappings.find((mapping) => mapping.nativeToolIds.includes('documents.create'))?.status,
      'disabled'
    );
    assert.equal((await getWorkflowDefinition('workspace-1', 'cluster-triage'))?.readiness.status, 'ready');

    const audit = await db.query<{ event_type: string }>(
      `SELECT event_type FROM workspace_audit_events
       WHERE workspace_id=$1 AND object_type='agent_native_tool' ORDER BY occurred_at`,
      ['workspace-1']
    );
    assert.deepEqual(audit.rows.map((row) => row.event_type), [
      'agent.native_tool_granted.v1',
      'agent.native_tool_revoked.v1'
    ]);
  });
});
