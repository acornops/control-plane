import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  deleteWorkflowThroughDefinitionService,
  updateAgentThroughDefinitionService,
  updateWorkflowThroughDefinitionService
} from '../src/services/automation-definition-service.js';
import {
  installAutomationTemplate,
  listAutomationTemplateBundles
} from '../src/services/automation-template-lifecycle.js';
import { refreshAgentReadiness } from '../src/services/automation-readiness.js';
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
    const agents = await db.query<{
      id: string;
      name: string;
      status: string;
      review_state: string;
      semantic_capability_ids: string[];
      tools: string[];
    }>(
      `SELECT id,name,status,review_state,semantic_capability_ids,tools
       FROM agent_definitions WHERE workspace_id=$1 ORDER BY name`,
      ['workspace-provisioned']
    );
    assert.equal(agents.rowCount, 2);
    assert.equal(
      agents.rows.every((agent) => agent.status === 'active' && agent.review_state === 'reviewed'),
      true
    );
    assert.deepEqual(agents.rows.map((agent) => agent.name), [
      'Kubernetes Agent',
      'Virtual Machine Agent'
    ]);
    assert.deepEqual([...agents.rows[0].semantic_capability_ids].sort(), [
      'documents.create',
      'infrastructure.diagnostics.read',
      'infrastructure.remediation.write'
    ].sort());
    assert.deepEqual([...agents.rows[1].semantic_capability_ids].sort(), [
      'documents.create',
      'infrastructure.diagnostics.read'
    ].sort());
    assert.equal(agents.rows.every((agent) => agent.tools.includes('documents.create')), true);
    const virtualMachineAgent = agents.rows[1];
    assert.deepEqual(
      (await refreshAgentReadiness('workspace-provisioned', virtualMachineAgent.id))?.readiness,
      { status: 'ready', reasons: [] }
    );
    const workflows = await db.query<{ status: string; readiness_status: string; agent_ids: string[] }>(
      'SELECT status,readiness_status,agent_ids FROM workflow_definitions WHERE workspace_id=$1',
      ['workspace-provisioned']
    );
    assert.equal(workflows.rowCount, 2);
    assert.deepEqual(workflows.rows.map((workflow) => workflow.agent_ids.length).sort(), [1, 1]);
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
      'automation.defaults_created.v1',
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

  it('never overwrites or automatically restores workspace default Agents or workflows', async () => {
    const seeded = await provisionStarterAutomation({
      workspaceId: 'workspace-1',
      installedBy: 'user-1'
    });
    const editedAgentId = seeded.installation.recordIds['agent:kubernetesAgent'];
    const editedWorkflowId = seeded.installation.recordIds['workflow:kubernetesHealth'];
    const deletedWorkflowId = seeded.installation.recordIds['workflow:virtualMachineHealth'];

    const editedAgent = await updateAgentThroughDefinitionService('workspace-1', editedAgentId, {
      name: 'My diagnostics Agent'
    });
    assert.equal(editedAgent?.name, 'My diagnostics Agent');
    const edited = await updateWorkflowThroughDefinitionService('workspace-1', editedWorkflowId, {
      name: 'My diagnostics workflow'
    });
    assert.equal(edited?.name, 'My diagnostics workflow');
    assert.equal(
      await deleteWorkflowThroughDefinitionService('workspace-1', deletedWorkflowId),
      'deleted'
    );

    const repeated = await provisionStarterAutomation({
      workspaceId: 'workspace-1',
      installedBy: 'user-1'
    });
    assert.equal(repeated.alreadySeeded, true);
    assert.equal(
      (await getAgentDefinition('workspace-1', editedAgentId))?.name,
      'My diagnostics Agent'
    );
    assert.equal(
      (await getWorkflowDefinition('workspace-1', editedWorkflowId))?.name,
      'My diagnostics workflow'
    );
    assert.equal(await getWorkflowDefinition('workspace-1', deletedWorkflowId), null);
    assert.equal(
      (await db.query(
        'SELECT 1 FROM workflow_definitions WHERE workspace_id=$1',
        ['workspace-1']
      )).rowCount,
      1
    );
  });

  it('re-adds a deleted default only when requested and returns no stale workflow ID', async () => {
    const seeded = await provisionStarterAutomation({
      workspaceId: 'workspace-1',
      installedBy: 'user-1'
    });
    const deletedWorkflowId = seeded.installation.recordIds['workflow:virtualMachineHealth'];
    assert.equal(
      await deleteWorkflowThroughDefinitionService('workspace-1', deletedWorkflowId),
      'deleted'
    );

    const recommendation = (await listAutomationTemplateBundles('workspace-1'))
      .find((item) => item.id === 'virtual-machine-health-check');
    assert.equal(recommendation?.installationStatus, 'not_installed');
    assert.equal(recommendation?.workflowId, undefined);

    const added = await installAutomationTemplate({
      workspaceId: 'workspace-1',
      templateId: 'virtual-machine-health-check',
      installedBy: 'user-1'
    });
    assert.equal(added.alreadyInstalled, false);
    assert.notEqual(added.workflowId, deletedWorkflowId);
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
    const specialistId = seeded.installation.recordIds['agent:kubernetesAgent'];
    const directWorkflowId = seeded.installation.recordIds['workflow:kubernetesHealth'];
    const virtualMachineWorkflowId = seeded.installation.recordIds['workflow:virtualMachineHealth'];
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
      await deleteWorkflowThroughDefinitionService('workspace-1', virtualMachineWorkflowId),
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

    const readded = await installAutomationTemplate({
      workspaceId: 'workspace-1',
      templateId: 'incident-investigation',
      installedBy: 'user-1'
    });
    const [installationReadded] = await listTemplateInstallations('workspace-1');
    const replacementSpecialistId = installationReadded.recordIds['agent:kubernetesAgent'];
    assert.notEqual(replacementSpecialistId, specialistId);
    assert.notEqual(readded.workflowId, coordinatedWorkflowId);
    assert.equal(await getAgentDefinition('workspace-1', replacementSpecialistId) !== null, true);
  });
});
