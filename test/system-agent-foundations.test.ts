import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../src/auth/authorization.js';
import { db } from '../src/infra/db.js';
import { compileAgentRunScope } from '../src/services/agent-access.js';
import { refreshAgentReadiness } from '../src/services/automation-readiness.js';
import {
  createAgentThroughDefinitionService,
  createWorkflowThroughDefinitionService,
  DefinitionValidationError,
  updateAgentThroughDefinitionService,
  updateWorkflowThroughDefinitionService
} from '../src/services/automation-definition-service.js';
import {
  backfillStarterAutomationV1,
  overrideStarterAutomationSeedFailureForTests,
  seedStarterAutomationV1
} from '../src/services/automation-templates.js';
import { provisionWorkspaceWithStarterAutomationV1 } from '../src/services/workspace-provisioning.js';
import { installAutomationTemplate } from '../src/services/automation-template-lifecycle.js';
import {
  deleteAgentWithInstallationCleanup,
  deleteWorkflowWithInternalManagerCleanup,
  listAgentWorkflowDependencies
} from '../src/store/repository-automation-cleanup.js';
import { listTemplateInstallations } from '../src/store/repository-automation-templates.js';
import {
  deleteAgentDefinition,
  getAgentDefinition
} from '../src/store/repository-agents.js';
import { createCapabilityRoutingMapping } from '../src/store/repository-capability-routing.js';
import {
  deleteWorkflowDefinition,
  getWorkflowDefinition
} from '../src/store/repository-workflows.js';
import type { AgentDefinition } from '../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../src/types/capability-routing.js';
import type { WorkflowDefinitionForAccess } from '../src/types/workflows.js';
import { getWorkspaceNativeTool } from '../src/services/workspace-native-tools.js';
import { closeAutomationDatabaseFixtures, resetAutomationDatabaseFixtures } from './helpers/automation-database-fixtures.js';

beforeEach(resetAutomationDatabaseFixtures);
after(closeAutomationDatabaseFixtures);

const agentKeys = ['targetDiagnostics', 'targetRemediation', 'incidentReporter'] as const;
const workflowKeys = ['targetDiagnostics', 'targetRemediation', 'incidentReporter', 'managedResponse'] as const;
function comparableAgent(agent: AgentDefinition, namesById: Map<string, string>) {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    status: agent.status,
    kind: agent.kind,
    reviewState: agent.reviewState,
    providerType: agent.providerType,
    version: agent.version,
    mcpServers: agent.mcpServers,
    mcpTools: agent.mcpTools,
    mcpInstallations: agent.mcpInstallations,
    tools: agent.tools,
    skills: agent.skills,
    skillInstallations: agent.skillInstallations,
    contextGrants: agent.contextGrants,
    targetScope: agent.targetScope,
    approvalPolicy: agent.approvalPolicy,
    trustPolicy: agent.trustPolicy,
    permissionMode: agent.permissionMode,
    semanticCapabilityIds: agent.semanticCapabilityIds,
    delegateAgents: agent.delegateAgentIds.map((id) => namesById.get(id)).sort(),
    readiness: agent.readiness
  };
}

function comparableWorkflow(workflow: WorkflowDefinitionForAccess, namesById: Map<string, string>) {
  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    prompt: workflow.prompt,
    selectedAgents: workflow.agentIds.map((id) => namesById.get(id)).sort(),
    executionMode: workflow.executionMode,
    targetConstraints: workflow.targetConstraints,
    capabilityPolicy: workflow.capabilityPolicy,
    tags: workflow.tags,
    inputs: workflow.inputs,
    requiredPermissions: workflow.requiredPermissions,
    readiness: workflow.readiness,
    version: workflow.version
  };
}

function mappingFor(agent: AgentDefinition): CapabilityRoutingMapping {
  return {
    id: `mapping-${agent.id}`,
    workspaceId: agent.workspaceId,
    capabilityId: 'target.diagnostics.read',
    version: 1,
    agentId: agent.id,
    agentVersion: agent.version,
    status: 'active',
    reviewState: 'reviewed',
    priority: 100,
    targetTypes: ['kubernetes', 'virtual_machine'],
    targetIds: [],
    mcpTools: [],
    nativeToolIds: ['target.diagnostics.inspect'],
    skillIds: [],
    contextGrants: [],
    createdBy: 'user-1',
    reviewedBy: 'user-1',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z'
  };
}

function comparableScope(scope: ReturnType<typeof compileAgentRunScope>) {
  return {
    ...scope,
    agentId: '<agent>',
    jwtClaims: { ...scope.jwtClaims, agent_id: '<agent>' }
  };
}

describe('automation template foundations', () => {
  it('keeps runtime parity while protecting system-provided definitions from direct edits', async () => {
    const installed = await seedStarterAutomationV1({
      workspaceId: 'workspace-1', installedBy: 'user-1'
    });
    assert.equal(installed.alreadySeeded, false);
    assert.equal(installed.installation.state, 'complete');
    assert.deepEqual(Object.keys(installed.installation.recordIds).sort(), ['agent:incidentReporter', 'agent:targetDiagnostics', 'workflow:incidentReporter', 'workflow:targetDiagnostics']);
    for (const templateId of ['target-remediation', 'incident-investigation']) {
      const result = await installAutomationTemplate({ workspaceId: 'workspace-1', templateId, installedBy: 'user-1' });
      assert.equal(result.alreadyInstalled, false);
    }
    const [installation] = await listTemplateInstallations('workspace-1');

    const generatedAgents = Object.fromEntries(await Promise.all(agentKeys.map(async (key) => {
      const agent = await getAgentDefinition('workspace-1', installation.recordIds[`agent:${key}`]);
      assert.ok(agent);
      return [key, agent];
    }))) as Record<(typeof agentKeys)[number], AgentDefinition>;

    const manualAgents = {} as Record<(typeof agentKeys)[number], AgentDefinition>;
    for (const key of agentKeys) {
      const source = generatedAgents[key];
      manualAgents[key] = await createAgentThroughDefinitionService({
        workspaceId: source.workspaceId,
        name: source.name,
        description: source.description,
        instructions: source.instructions,
        ownerUserId: 'user-1',
        createdBy: 'user-1',
        origin: { type: 'manual' },
        kind: source.kind,
        reviewState: source.reviewState,
        providerType: source.providerType,
        permissionMode: source.permissionMode,
        tools: source.tools,
        semanticCapabilityIds: source.semanticCapabilityIds,
        targetScope: source.targetScope,
        approvalPolicy: source.approvalPolicy,
        trustPolicy: source.trustPolicy
      });
      for (const toolId of source.tools) {
        const tool = getWorkspaceNativeTool(toolId);
        assert.ok(tool);
        await createCapabilityRoutingMapping({
          workspaceId: source.workspaceId,
          capabilityId: tool.semanticCapabilityId,
          agentId: manualAgents[key].id,
          agentVersion: manualAgents[key].version,
          status: 'active',
          reviewState: 'reviewed',
          priority: 100,
          targetTypes: [],
          targetIds: [],
          mcpTools: [],
          nativeToolIds: [tool.id],
          invocationScopes: tool.invocationScopes,
          skillIds: [],
          contextGrants: tool.requiredContextGrant ? [tool.requiredContextGrant] : [],
          createdBy: 'user-1',
          reviewedBy: 'user-1'
        });
      }
      manualAgents[key] = (await refreshAgentReadiness(source.workspaceId, manualAgents[key].id)) || manualAgents[key];
    }
    const generatedNames = new Map(Object.values(generatedAgents).map((agent) => [agent.id, agent.name]));
    const manualNames = new Map(Object.values(manualAgents).map((agent) => [agent.id, agent.name]));
    for (const key of agentKeys) {
      assert.deepEqual(
        comparableAgent(generatedAgents[key], generatedNames),
        comparableAgent(manualAgents[key], manualNames)
      );
    }

    const generatedWorkflows = Object.fromEntries(await Promise.all(workflowKeys.map(async (key) => {
      const workflow = await getWorkflowDefinition('workspace-1', installation.recordIds[`workflow:${key}`]);
      assert.ok(workflow);
      return [key, workflow];
    }))) as Record<(typeof workflowKeys)[number], WorkflowDefinitionForAccess>;
    assert.equal(
      generatedWorkflows.targetDiagnostics.prompt,
      'Inspect @target[Target name] using live diagnostic evidence and summarize findings and safe next actions.'
    );
    assert.equal(generatedWorkflows.targetDiagnostics.description, 'Inspect one exact target using live diagnostic evidence.');
    assert.equal(
      generatedWorkflows.targetRemediation.prompt,
      'Diagnose @target[Target name] using live evidence. Propose the smallest safe change, request approval before each mutation, verify the result, and summarize rollback guidance.'
    );
    assert.equal(generatedWorkflows.targetRemediation.capabilityPolicy.mode, 'read_write');
    assert.deepEqual(
      generatedWorkflows.targetRemediation.capabilityPolicy.semanticCapabilityIds,
      ['target.diagnostics.read', 'target.remediation.write']
    );
    assert.deepEqual(
      generatedWorkflows.targetRemediation.capabilityPolicy.approvalRequirements,
      ['Before every write-capable target tool']
    );
    const manualWorkflows = {} as Record<(typeof workflowKeys)[number], WorkflowDefinitionForAccess>;
    for (const key of workflowKeys) {
      const source = generatedWorkflows[key];
      manualWorkflows[key] = await createWorkflowThroughDefinitionService({
        workspaceId: source.workspaceId,
        name: source.name,
        description: source.description,
        prompt: source.prompt,
        agentIds: source.agentIds.map((id) => {
          const specialistKey = agentKeys.find((candidate) => generatedAgents[candidate].id === id)!;
          return manualAgents[specialistKey].id;
        }),
        targetConstraints: source.targetConstraints,
        capabilityPolicy: source.capabilityPolicy,
        tags: source.tags,
        inputs: source.inputs,
        requiredPermissions: source.requiredPermissions,
        createdBy: 'user-1',
        origin: { type: 'manual' },
        status: source.status
      });
      assert.deepEqual(
        comparableWorkflow(source, generatedNames),
        comparableWorkflow(manualWorkflows[key], manualNames)
      );
    }

    const actor = {
      userId: 'user-1', role: 'admin',
      permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
    };
    const generatedScope = compileAgentRunScope({
      agent: generatedAgents.targetDiagnostics, actor, approvedContextGrants: [],
      exactTarget: { id: 'cluster-1', targetType: 'kubernetes' },
      mappings: [mappingFor(generatedAgents.targetDiagnostics)]
    });
    const manualScope = compileAgentRunScope({
      agent: manualAgents.targetDiagnostics, actor, approvedContextGrants: [],
      exactTarget: { id: 'cluster-1', targetType: 'kubernetes' },
      mappings: [mappingFor(manualAgents.targetDiagnostics)]
    });
    assert.deepEqual(comparableScope(generatedScope), comparableScope(manualScope));

    await assert.rejects(
      updateAgentThroughDefinitionService('workspace-1', generatedAgents.targetDiagnostics.id, { instructions: 'Replace system instructions.' }),
      (error: unknown) => error instanceof DefinitionValidationError
        && error.code === 'SYSTEM_AGENT_DEFINITION_IMMUTABLE'
    );
    const manualAgentUpdated = await updateAgentThroughDefinitionService(
      'workspace-1', manualAgents.targetDiagnostics.id, { instructions: 'Use updated custom instructions.' }
    );
    assert.equal(manualAgentUpdated?.instructions, 'Use updated custom instructions.');

    await assert.rejects(
      updateWorkflowThroughDefinitionService('workspace-1', generatedWorkflows.targetDiagnostics.id, { prompt: 'Replace the system prompt.' }),
      (error: unknown) => error instanceof DefinitionValidationError
        && error.code === 'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE'
    );
    const manualWorkflowUpdated = await updateWorkflowThroughDefinitionService(
      'workspace-1', manualWorkflows.targetDiagnostics.id, { prompt: 'Use an updated custom prompt.' }
    );
    assert.equal(manualWorkflowUpdated?.prompt, 'Use an updated custom prompt.');

    for (const key of workflowKeys) {
      assert.equal(await deleteWorkflowDefinition('workspace-1', generatedWorkflows[key].id), 'deleted');
      assert.equal(await deleteWorkflowDefinition('workspace-1', manualWorkflows[key].id), 'deleted');
    }
    for (const key of [...agentKeys].reverse()) {
      assert.equal(await deleteAgentDefinition('workspace-1', generatedAgents[key].id), true);
      assert.equal(await deleteAgentDefinition('workspace-1', manualAgents[key].id), true);
    }

    const reinstalled = await seedStarterAutomationV1({
      workspaceId: 'workspace-1', installedBy: 'user-1'
    });
    assert.equal(reinstalled.alreadySeeded, true);
    const coordinated = await getWorkflowDefinition('workspace-1', installation.recordIds['workflow:managedResponse']);
    assert.equal(coordinated, null);
  });

  it('provisions a workspace, owner, starter definitions, installation, and audit atomically', async () => {
    const provisioned = await provisionWorkspaceWithStarterAutomationV1({
      id: 'workspace-provisioned',
      name: 'Provisioned Workspace',
      createdBy: 'user-1'
    });
    assert.equal(provisioned.created, true);

    const agents = await db.query<{ kind: string; origin: { type: string }; status: string; review_state: string }>(
      'SELECT kind,origin,status,review_state FROM agent_definitions WHERE workspace_id=$1',
      ['workspace-provisioned']
    );
    assert.equal(agents.rows.filter((agent) => agent.kind === 'specialist').length, 2);
    assert.equal(agents.rows.filter((agent) => agent.kind === 'manager').length, 1);
    assert.equal(agents.rows.every((agent) => agent.status === 'active' && agent.review_state === 'reviewed'), true);

    const workflows = await db.query<{ status: string; readiness_status: string }>(
      'SELECT status,readiness_status FROM workflow_definitions WHERE workspace_id=$1',
      ['workspace-provisioned']
    );
    assert.equal(workflows.rowCount, 2);
    assert.equal(workflows.rows.filter((workflow) => workflow.status === 'active').length, 2);
    assert.equal(workflows.rows.filter((workflow) => workflow.status === 'draft').length, 0);
    assert.equal(workflows.rows.filter((workflow) => workflow.status === 'paused').length, 0);
    assert.equal(workflows.rows.filter((workflow) => workflow.readiness_status === 'ready').length, 1);
    assert.equal(workflows.rows.filter((workflow) => workflow.readiness_status === 'needs_setup').length, 1);
    const installations = await listTemplateInstallations('workspace-provisioned');
    assert.equal(installations.length, 1);
    assert.equal(installations[0].state, 'complete');
    assert.equal(installations[0].templateVersion, 4);
    assert.equal(Object.keys(installations[0].recordIds).length, 4);

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

  it('rolls back the whole workspace when starter provisioning fails', async () => {
    overrideStarterAutomationSeedFailureForTests('after_agents');
    try {
      await assert.rejects(
        provisionWorkspaceWithStarterAutomationV1({
          id: 'workspace-rollback',
          name: 'Rollback Workspace',
          createdBy: 'user-1'
        }),
        /Injected starter automation seed failure/
      );
    } finally {
      overrideStarterAutomationSeedFailureForTests(null);
    }
    assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id=$1', ['workspace-rollback'])).rowCount, 0);
    for (const table of [
      'workspace_memberships',
      'agent_definitions',
      'workflow_definitions',
      'automation_template_installations',
      'workspace_audit_events'
    ]) {
      const result = await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, ['workspace-rollback']);
      assert.equal(result.rowCount, 0, `${table} should roll back`);
    }
  });

  it('backfills missing and pending installations once and remains idempotent', async () => {
    await db.query(
      `INSERT INTO automation_template_installations (
         workspace_id,template_id,template_version,state,installed_by,record_ids
       ) VALUES ('workspace-1','acornops-starter',1,'pending','user-1','{}'::jsonb)`
    );

    await backfillStarterAutomationV1();

    const installations = await db.query<{ workspace_id: string; state: string; record_count: number }>(
      `SELECT workspace_id,state,
              (SELECT COUNT(*)::int FROM jsonb_object_keys(installation.record_ids)) AS record_count
       FROM automation_template_installations installation
       WHERE template_id='acornops-starter'
       ORDER BY workspace_id`
    );
    assert.deepEqual(installations.rows, [
      { workspace_id: 'workspace-1', state: 'complete', record_count: 4 },
      { workspace_id: 'workspace-2', state: 'complete', record_count: 4 }
    ]);
    assert.equal((await db.query('SELECT 1 FROM agent_definitions')).rowCount, 6);
    assert.equal((await db.query('SELECT 1 FROM workflow_definitions')).rowCount, 4);

    await backfillStarterAutomationV1();

    assert.equal((await db.query('SELECT 1 FROM agent_definitions')).rowCount, 6);
    assert.equal((await db.query('SELECT 1 FROM workflow_definitions')).rowCount, 4);
    assert.equal((await db.query(
      "SELECT 1 FROM workspace_audit_events WHERE event_type='automation.template_seeded.v1'"
    )).rowCount, 2);
  });

  it('deletes visible starter definitions, reports workflow dependencies, and prunes tombstone references', async () => {
    const seeded = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    await installAutomationTemplate({ workspaceId: 'workspace-1', templateId: 'incident-investigation', installedBy: 'user-1' });
    const [installationBeforeDeletion] = await listTemplateInstallations('workspace-1');
    const specialistId = seeded.installation.recordIds['agent:targetDiagnostics'];
    const directWorkflowId = seeded.installation.recordIds['workflow:targetDiagnostics'];
    const managedWorkflowId = installationBeforeDeletion.recordIds['workflow:managedResponse'];
    const managedWorkflow = await getWorkflowDefinition('workspace-1', managedWorkflowId);
    assert.ok(managedWorkflow);
    const coordinatorId = managedWorkflow.entryAgentId;

    const dependencies = await listAgentWorkflowDependencies('workspace-1', specialistId);
    assert.deepEqual(dependencies.map((dependency) => dependency.relation).sort(), [
      'selected_agent',
      'selected_agent'
    ]);
    assert.equal((await deleteAgentWithInstallationCleanup('workspace-1', specialistId)).status, 'conflict');

    assert.equal((await deleteWorkflowWithInternalManagerCleanup('workspace-1', directWorkflowId)).status, 'deleted');
    const managedDeletion = await deleteWorkflowWithInternalManagerCleanup('workspace-1', managedWorkflowId);
    assert.equal(managedDeletion.status, 'deleted');
    assert.equal(managedDeletion.removedInternalManagerId, undefined);
    assert.ok(await getAgentDefinition('workspace-1', coordinatorId));
    assert.equal((await deleteAgentWithInstallationCleanup('workspace-1', specialistId)).status, 'deleted');

    const [installation] = await listTemplateInstallations('workspace-1');
    assert.equal(installation.state, 'complete');
    assert.equal(Object.values(installation.recordIds).includes(directWorkflowId), false);
    assert.equal(Object.values(installation.recordIds).includes(managedWorkflowId), false);
    assert.equal(Object.values(installation.recordIds).includes(specialistId), false);

    const repeated = await seedStarterAutomationV1({ workspaceId: 'workspace-1', installedBy: 'user-1' });
    assert.equal(repeated.alreadySeeded, true);
    assert.equal(await getAgentDefinition('workspace-1', specialistId), null);

    const reinstalled = await installAutomationTemplate({ workspaceId: 'workspace-1', templateId: 'target-diagnostics', installedBy: 'user-1' });
    assert.equal(reinstalled.alreadyInstalled, false);
    assert.notEqual(reinstalled.workflowId, directWorkflowId);
    assert.equal((await getWorkflowDefinition('workspace-1', reinstalled.workflowId))?.status, 'active');
    const idempotent = await installAutomationTemplate({ workspaceId: 'workspace-1', templateId: 'target-diagnostics', installedBy: 'user-1' });
    assert.deepEqual(idempotent, { workflowId: reinstalled.workflowId, alreadyInstalled: true });
  });
});
