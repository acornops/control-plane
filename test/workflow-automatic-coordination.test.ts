import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
  backfillWorkflowCoordinationInfrastructure,
  createWorkflowThroughDefinitionService,
  DefinitionValidationError,
  deleteWorkflowThroughDefinitionService
} from '../src/services/automation-definition-service.js';
import type { WorkflowCapabilityPolicy } from '../src/types/workflows.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

const readPolicy: WorkflowCapabilityPolicy = {
  mode: 'read_only',
  semanticCapabilityIds: ['incident.report.generate', 'target.diagnostics.read'],
  contextGrants: [],
  maxRuntimeSeconds: 900,
  retentionDays: 30,
  approvalRequirements: []
};

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures(['workspace-1']);
});

after(closeAutomationDatabaseFixtures);

describe('automatic workflow coordination', () => {
  it('backfills one persistent coordinator per workspace and repairs internal routing', async () => {
    const workflow = await createWorkflowThroughDefinitionService({
      workspaceId: 'workspace-1',
      name: 'Legacy coordinated workflow',
      prompt: 'Coordinate the selected specialists.',
      agentIds: ['agent-incident-reporter', 'agent-cluster-triage'],
      capabilityPolicy: readPolicy,
      requiredPermissions: ['read_workspace_data'],
      createdBy: 'user-1'
    });
    await db.query(
      `UPDATE workflow_definitions
       SET entry_agent_id='agent-cluster-triage',delegation_policy=NULL
       WHERE workspace_id='workspace-1' AND id=$1`,
      [workflow.id]
    );

    await backfillWorkflowCoordinationInfrastructure();

    const coordinators = await db.query<{ workspace_id: string; id: string }>(
      `SELECT workspace_id,id FROM agent_definitions
       WHERE system_role='workflow_coordinator' ORDER BY workspace_id`
    );
    assert.deepEqual(coordinators.rows.map((row) => row.workspace_id), ['workspace-1', 'workspace-2']);
    const workspaceCoordinator = coordinators.rows.find((row) => row.workspace_id === 'workspace-1');
    assert.ok(workspaceCoordinator);
    const repaired = await db.query<{ entry_agent_id: string; delegation_policy: { specialistAgentIds: string[] } }>(
      `SELECT entry_agent_id,delegation_policy FROM workflow_definitions
       WHERE workspace_id='workspace-1' AND id=$1`,
      [workflow.id]
    );
    assert.equal(repaired.rows[0].entry_agent_id, workspaceCoordinator.id);
    assert.deepEqual(repaired.rows[0].delegation_policy.specialistAgentIds, [
      'agent-cluster-triage',
      'agent-incident-reporter'
    ]);
  });

  it('creates one coordinator under concurrent coordinated workflow mutations', async () => {
    const create = (name: string) => createWorkflowThroughDefinitionService({
      workspaceId: 'workspace-1',
      name,
      prompt: 'Coordinate the selected specialists.',
      agentIds: ['agent-incident-reporter', 'agent-cluster-triage'],
      capabilityPolicy: readPolicy,
      requiredPermissions: ['read_workspace_data'],
      createdBy: 'user-1'
    });

    const [first, second] = await Promise.all([create('Coordinated one'), create('Coordinated two')]);
    assert.equal(first.executionMode, 'coordinated');
    assert.equal(second.executionMode, 'coordinated');
    assert.deepEqual(first.agentIds, ['agent-cluster-triage', 'agent-incident-reporter']);

    const coordinators = await db.query<{
      id: string;
      version: number;
      delegate_agent_ids: string[];
      semantic_capability_ids: string[];
    }>(
      `SELECT id,version,delegate_agent_ids,semantic_capability_ids
       FROM agent_definitions
       WHERE workspace_id=$1 AND system_role='workflow_coordinator'`,
      ['workspace-1']
    );
    assert.equal(coordinators.rowCount, 1);
    assert.deepEqual(coordinators.rows[0].delegate_agent_ids, ['agent-cluster-triage', 'agent-incident-reporter']);
    assert.deepEqual(coordinators.rows[0].semantic_capability_ids, ['incident.report.generate', 'target.diagnostics.read']);
    const unchangedVersion = coordinators.rows[0].version;

    assert.equal(await deleteWorkflowThroughDefinitionService('workspace-1', first.id), 'deleted');
    const afterFirstDelete = await db.query<{ version: number }>(
      `SELECT version FROM agent_definitions
       WHERE workspace_id=$1 AND system_role='workflow_coordinator'`,
      ['workspace-1']
    );
    assert.equal(afterFirstDelete.rows[0].version, unchangedVersion);

    assert.equal(await deleteWorkflowThroughDefinitionService('workspace-1', second.id), 'deleted');
    const afterLastDelete = await db.query<{ version: number; delegate_agent_ids: string[] }>(
      `SELECT version,delegate_agent_ids FROM agent_definitions
       WHERE workspace_id=$1 AND system_role='workflow_coordinator'`,
      ['workspace-1']
    );
    assert.equal(afterLastDelete.rows[0].version, unchangedVersion + 1);
    assert.deepEqual(afterLastDelete.rows[0].delegate_agent_ids, []);
  });

  it('rejects duplicate selections and system-owned coordinator IDs', async () => {
    const create = (agentIds: string[]) => createWorkflowThroughDefinitionService({
      workspaceId: 'workspace-1',
      name: 'Rejected selection',
      prompt: 'Run the workflow.',
      agentIds,
      capabilityPolicy: { ...readPolicy, semanticCapabilityIds: ['target.diagnostics.read'] },
      requiredPermissions: ['read_workspace_data'],
      createdBy: 'user-1'
    });

    await assert.rejects(
      create(['agent-cluster-triage', 'agent-cluster-triage']),
      (error: unknown) => error instanceof DefinitionValidationError
        && error.code === 'WORKFLOW_AGENT_SELECTION_DUPLICATE'
    );

    await create(['agent-cluster-triage']);
    const coordinator = await db.query<{ id: string }>(
      `SELECT id FROM agent_definitions
       WHERE workspace_id=$1 AND system_role='workflow_coordinator'`,
      ['workspace-1']
    );
    await assert.rejects(
      create([coordinator.rows[0].id]),
      (error: unknown) => error instanceof DefinitionValidationError
        && error.code === 'MANAGER_SYSTEM_OWNED'
    );
  });
});
