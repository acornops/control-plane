import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { setAgentNativeToolAssignment } from '../src/services/agent-native-tools.js';
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
  it('versions and rebinds reviewed mappings while refreshing dependent readiness', async () => {
    const before = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(before);
    assert.equal(before.version, 2);

    const granted = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'reports.pdf.generate',
      assigned: true,
      actorUserId: 'user-1'
    });
    assert.equal(granted.version, 3);
    assert.ok(granted.tools.includes('reports.pdf.generate'));
    assert.ok(granted.semanticCapabilityIds.includes('reports.pdf.generate'));
    assert.equal(granted.readiness.status, 'ready');

    const afterGrantMappings = (await listCapabilityRoutingMappings('workspace-1'))
      .filter((mapping) => mapping.agentId === before.id);
    assert.ok(afterGrantMappings.filter((mapping) => mapping.status === 'active')
      .every((mapping) => mapping.agentVersion === granted.version));
    const nativeMapping = afterGrantMappings.find((mapping) => mapping.nativeToolIds.includes('reports.pdf.generate'));
    assert.ok(nativeMapping);
    assert.deepEqual(nativeMapping.invocationScopes, ['workflow', 'target_chat']);
    assert.equal(nativeMapping.reviewState, 'reviewed');

    const dependentAfterGrant = await getWorkflowDefinition('workspace-1', 'cluster-triage');
    assert.equal(dependentAfterGrant?.readiness.status, 'ready');

    const revoked = await setAgentNativeToolAssignment({
      workspaceId: 'workspace-1',
      agentId: before.id,
      toolId: 'reports.pdf.generate',
      assigned: false,
      actorUserId: 'user-1'
    });
    assert.equal(revoked.version, 4);
    assert.equal(revoked.tools.includes('reports.pdf.generate'), false);
    assert.equal(revoked.semanticCapabilityIds.includes('reports.pdf.generate'), false);
    assert.equal(revoked.readiness.status, 'ready');

    const afterRevokeMappings = (await listCapabilityRoutingMappings('workspace-1'))
      .filter((mapping) => mapping.agentId === before.id);
    assert.equal(
      afterRevokeMappings.find((mapping) => mapping.nativeToolIds.includes('reports.pdf.generate'))?.status,
      'disabled'
    );
    assert.ok(afterRevokeMappings.filter((mapping) => mapping.status === 'active')
      .every((mapping) => mapping.agentVersion === revoked.version));
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
