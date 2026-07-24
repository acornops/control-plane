import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  deleteWorkflowThroughDefinitionService
} from '../src/services/automation-definition-service.js';
import { installAutomationTemplate } from '../src/services/automation-template-lifecycle.js';
import {
  overrideStarterAutomationSeedFailureForTests,
  provisionStarterAutomation
} from '../src/services/automation-templates.js';
import { provisionWorkspaceWithStarterAutomation } from '../src/services/workspace-provisioning.js';
import {
  deleteAgentWithInstallationCleanup,
  listAgentWorkflowDependencies
} from '../src/store/repository-automation-cleanup.js';
import { listTemplateInstallations } from '../src/store/repository-automation-templates.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { getWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

describe('Workflow and Agent template foundations', () => {
  it('provisions workspace ownership, specialist profiles, workflows, installation, and audit atomically', async () => {
    const provisioned = await provisionWorkspaceWithStarterAutomation({
      id: 'workspace-provisioned',
      name: 'Provisioned Workspace',
      createdBy: 'user-1'
    });
    assert.equal(provisioned.created, true);
    const agents = await db.query<{ status: string; review_state: string }>(
      'SELECT status,review_state FROM agent_definitions WHERE workspace_id=$1',
      ['workspace-provisioned']
    );
    assert.equal(agents.rowCount, 2);
    assert.equal(
      agents.rows.every((agent) => agent.status === 'active' && agent.review_state === 'reviewed'),
      true
    );
    const workflows = await db.query<{ status: string; readiness_status: string; agent_ids: string[] }>(
      'SELECT status,readiness_status,agent_ids FROM workflow_definitions WHERE workspace_id=$1',
      ['workspace-provisioned']
    );
    assert.equal(workflows.rowCount, 2);
    assert.equal(workflows.rows.every((workflow) => workflow.agent_ids.length === 1), true);
    const [installation] = await listTemplateInstallations('workspace-provisioned');
    assert.equal(installation.state, 'complete');
    assert.equal(Object.keys(installation.recordIds).length, 4);
    const membership = await db.query(
      `SELECT 1 FROM workspace_memberships
       WHERE workspace_id='workspace-provisioned' AND user_id='user-1' AND role='owner'`
    );
    assert.equal(membership.rowCount, 1);
    const audit = await db.query<{ event_type: string }>(
      'SELECT event_type FROM workspace_audit_events WHERE workspace_id=$1 ORDER BY occurred_at',
      ['workspace-provisioned']
    );
    assert.deepEqual(audit.rows.map((row) => row.event_type).sort(), [
      'automation.template_seeded.v1',
      'workspace.created.v1'
    ]);
  });

  it('rolls back the entire workspace when starter provisioning fails', async () => {
    overrideStarterAutomationSeedFailureForTests('after_agents');
    try {
      await assert.rejects(
        provisionWorkspaceWithStarterAutomation({
          id: 'workspace-rollback',
          name: 'Rollback Workspace',
          createdBy: 'user-1'
        }),
        /Injected starter automation seed failure/
      );
    } finally {
      overrideStarterAutomationSeedFailureForTests(null);
    }
    assert.equal(
      (await db.query('SELECT 1 FROM workspaces WHERE id=$1', ['workspace-rollback'])).rowCount,
      0
    );
    for (const table of [
      'workspace_memberships',
      'agent_definitions',
      'workflow_definitions',
      'automation_template_installations',
      'workspace_audit_events'
    ]) {
      const result = await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [
        'workspace-rollback'
      ]);
      assert.equal(result.rowCount, 0, `${table} should roll back`);
    }
  });

  it('blocks assigned Agent deletion and prunes deleted Workflow and Agent installation references', async () => {
    const seeded = await provisionStarterAutomation({
      workspaceId: 'workspace-1',
      installedBy: 'user-1'
    });
    await installAutomationTemplate({
      workspaceId: 'workspace-1',
      templateId: 'incident-investigation',
      installedBy: 'user-1'
    });
    const [installationBefore] = await listTemplateInstallations('workspace-1');
    const specialistId = seeded.installation.recordIds['agent:targetDiagnostics'];
    const directWorkflowId = seeded.installation.recordIds['workflow:targetDiagnostics'];
    const coordinatedWorkflowId = installationBefore.recordIds['workflow:managedResponse'];
    assert.equal(
      (await getWorkflowDefinition('workspace-1', coordinatedWorkflowId))?.executionMode,
      'coordinated'
    );
    assert.deepEqual(
      (await listAgentWorkflowDependencies('workspace-1', specialistId))
        .map((dependency) => dependency.relation),
      ['selected_agent', 'selected_agent']
    );
    assert.equal(
      (await deleteAgentWithInstallationCleanup('workspace-1', specialistId)).status,
      'conflict'
    );

    assert.equal(
      await deleteWorkflowThroughDefinitionService('workspace-1', directWorkflowId),
      'deleted'
    );
    assert.equal(
      await deleteWorkflowThroughDefinitionService('workspace-1', coordinatedWorkflowId),
      'deleted'
    );
    assert.equal(
      (await deleteAgentWithInstallationCleanup('workspace-1', specialistId)).status,
      'deleted'
    );
    assert.equal(await getAgentDefinition('workspace-1', specialistId), null);
    const [installationAfter] = await listTemplateInstallations('workspace-1');
    assert.equal(Object.values(installationAfter.recordIds).includes(directWorkflowId), false);
    assert.equal(Object.values(installationAfter.recordIds).includes(coordinatedWorkflowId), false);
    assert.equal(Object.values(installationAfter.recordIds).includes(specialistId), false);
  });
});
