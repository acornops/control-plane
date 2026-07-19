import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import { seedStarterAutomationV1 } from '../src/services/automation-templates.js';
import { installAutomationTemplate } from '../src/services/automation-template-lifecycle.js';
import { listTemplateInstallations } from '../src/store/repository-automation-templates.js';
import { deleteWorkflowWithInternalManagerCleanup } from '../src/store/repository-automation-cleanup.js';
import { getAgentDefinition } from '../src/store/repository-agents.js';
import { getWorkflowDefinition } from '../src/store/repository-workflows.js';
import {
  closeAutomationDatabaseFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

describe('starter automation v4 upgrade', () => {
  it('upgrades surviving v1 starters without recreating tombstones or changing paused and disabled states', async () => {
    const seeded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    await installAutomationTemplate({ workspaceId: 'workspace-1', templateId: 'incident-investigation', installedBy: 'user-1' });
    const [installation] = await listTemplateInstallations('workspace-1');
    const incidentAgentId = seeded.installation.recordIds['agent:incidentReporter'];
    const incidentWorkflowId = seeded.installation.recordIds['workflow:incidentReporter'];
    const deletedWorkflowId = seeded.installation.recordIds['workflow:targetDiagnostics'];
    const investigationWorkflowId = installation.recordIds['workflow:managedResponse'];

    assert.equal((await deleteWorkflowWithInternalManagerCleanup('workspace-1', deletedWorkflowId)).status, 'deleted');
    await db.query(
      `UPDATE automation_template_installations SET template_version=1 WHERE workspace_id=$1 AND template_id=$2`,
      ['workspace-1', 'acornops-starter']
    );
    await db.query(
      `UPDATE agent_definitions SET status='disabled',tools='[]',semantic_capability_ids='["incident.report.generate"]',
         origin=jsonb_set(origin,'{templateVersion}','1'::jsonb,true)
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', incidentAgentId]
    );
    await db.query(
      `DELETE FROM capability_routing_mappings WHERE workspace_id=$1 AND agent_id=$2`,
      ['workspace-1', incidentAgentId]
    );
    await db.query(
      `UPDATE workflow_definitions SET status='paused',version=2,
         origin=jsonb_set(origin,'{templateVersion}','1'::jsonb,true)
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', incidentWorkflowId]
    );

    const upgraded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    assert.equal(upgraded.installation.templateVersion, 4);
    assert.equal(upgraded.alreadySeeded, false);
    assert.equal(await getWorkflowDefinition('workspace-1', deletedWorkflowId), null);
    const upgradedWorkflow = await getWorkflowDefinition('workspace-1', incidentWorkflowId);
    assert.equal(upgradedWorkflow?.status, 'paused');
    assert.equal(upgradedWorkflow?.capabilityPolicy.restrictionMode, 'inherit');
    assert.deepEqual(upgradedWorkflow?.capabilityPolicy.semanticCapabilityIds, []);
    assert.equal(upgradedWorkflow?.capabilityPolicy.retentionDays, 180);
    const upgradedAgent = await getAgentDefinition('workspace-1', incidentAgentId);
    assert.equal(upgradedAgent?.status, 'disabled');
    assert.deepEqual(upgradedAgent?.tools, ['chat.sessions.read_selected', 'reports.pdf.generate']);
    assert.deepEqual(upgradedAgent?.semanticCapabilityIds, ['chat.sessions.read_selected', 'reports.pdf.generate']);
    assert.equal((await getWorkflowDefinition('workspace-1', investigationWorkflowId))?.name, 'Incident investigation');
    assert.equal(upgraded.installation.recordIds['workflow:managedResponse'], investigationWorkflowId);

    const repeated = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    assert.equal(repeated.alreadySeeded, true);
    assert.equal(repeated.installation.templateVersion, 4);
  });

  it('activates only an untouched draft v1 Incident Report during upgrade', async () => {
    const seeded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    const incidentWorkflowId = seeded.installation.recordIds['workflow:incidentReporter'];
    await db.query(
      `UPDATE automation_template_installations SET template_version=1 WHERE workspace_id=$1 AND template_id=$2`,
      ['workspace-1', 'acornops-starter']
    );
    await db.query(
      `UPDATE workflow_definitions SET status='draft',version=1,
         origin=jsonb_set(origin,'{templateVersion}','1'::jsonb,true)
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', incidentWorkflowId]
    );

    await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    assert.equal((await getWorkflowDefinition('workspace-1', incidentWorkflowId))?.status, 'active');
  });

  it('activates a seeded draft Target diagnostics workflow without overriding an explicit pause', async () => {
    const seeded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    const targetDiagnosticsWorkflowId = seeded.installation.recordIds['workflow:targetDiagnostics'];
    const incidentWorkflowId = seeded.installation.recordIds['workflow:incidentReporter'];
    await db.query(
      `UPDATE automation_template_installations SET template_version=3 WHERE workspace_id=$1 AND template_id=$2`,
      ['workspace-1', 'acornops-starter']
    );
    await db.query(
      `UPDATE workflow_definitions SET status='draft',origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true)
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', targetDiagnosticsWorkflowId]
    );
    await db.query(
      `UPDATE workflow_definitions SET status='paused',origin=jsonb_set(origin,'{templateVersion}','3'::jsonb,true)
       WHERE workspace_id=$1 AND id=$2`,
      ['workspace-1', incidentWorkflowId]
    );

    const upgraded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });

    assert.equal(upgraded.installation.templateVersion, 4);
    assert.equal((await getWorkflowDefinition('workspace-1', targetDiagnosticsWorkflowId))?.status, 'active');
    assert.equal((await getWorkflowDefinition('workspace-1', incidentWorkflowId))?.status, 'paused');
  });
});
