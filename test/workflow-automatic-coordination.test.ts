import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { db } from '../src/infra/db.js';
import {
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
  restrictionMode: 'restrict',
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
