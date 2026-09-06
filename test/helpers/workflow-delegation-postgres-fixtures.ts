import assert from 'node:assert/strict';
import { getWorkspacePermissions } from '../../src/auth/authorization.js';
import { db } from '../../src/infra/db.js';
import { compileWorkflowAccessScope, compileWorkflowSessionCeiling } from '../../src/services/workflow-access.js';
import { getAgentDefinition } from '../../src/store/repository-agents.js';
import { listCapabilityRoutingMappings } from '../../src/store/repository-capability-routing.js';
import { createWorkflowDefinition, createWorkflowExecution, createWorkflowSession, updateWorkflowRun } from '../../src/store/repository-workflows.js';

export const actor = {
  userId: 'user-1',
  role: 'admin',
  permissions: getWorkspacePermissions('admin')
};
export async function coordinatedRoot() {
  const agents = (await Promise.all([
    getAgentDefinition('workspace-1', 'agent-cluster-triage'),
    getAgentDefinition('workspace-1', 'agent-incident-reporter')
  ])).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
  assert.equal(agents.length, 2);
  const workflow = await createWorkflowDefinition({
    workspaceId: 'workspace-1',
    name: 'Coordinated delegation probe',
    prompt: 'Inspect the infrastructure.',
    agentIds: agents.map((agent) => agent.id),
    createdBy: actor.userId,
    status: 'active'
  });
  const mappings = await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true });
  const ceiling = compileWorkflowSessionCeiling({
    workflow,
    selectedAgents: agents,
    mappings,
    actor,
  });
  const rootScope = compileWorkflowAccessScope({
    workflow,
    selectedAgents: agents,
    mappings,
    actor,
  });
  const session = await createWorkflowSession({
    workflow,
    createdBy: actor.userId,
    compiledAccessScope: ceiling
  });
  const created = await createWorkflowExecution({
    workflow,
    session,
    compiledAccessScope: rootScope,
    content: 'Inspect the infrastructure.'
  });
  const parent = await updateWorkflowRun(created.run.id, { status: 'running' });
  assert.ok(parent);
  await db.query("UPDATE workflow_executions SET status='running' WHERE id=$1", [created.execution.id]);
  await db.query(
    "UPDATE automation_dispatch_outbox SET status='delivered',delivered_at=NOW() WHERE run_id=$1",
    [parent.id]
  );
  const specialist = agents.find((agent) => agent.id === 'agent-cluster-triage');
  assert.ok(specialist);
  const childScope = compileWorkflowAccessScope({
    workflow,
    selectedAgents: agents,
    specialistAgent: specialist,
    delegatedSpecialist: true,
    mappings: mappings.filter((mapping) => mapping.agentId === specialist.id),
    actor,
  });
  return { parent, specialist, childScope };
}
export function delegationInput(
  setup: Awaited<ReturnType<typeof coordinatedRoot>>,
  toolCallId: string
) {
  return {
    parent: setup.parent,
    specialist: setup.specialist,
    compiledAccessScope: setup.childScope,
    toolCallId,
    capabilityId: 'infrastructure.diagnostics.read',
    taskPrompt: `Inspect the target for ${toolCallId}.`,
    required: true,
    maxConcurrentChildren: 4,
    maxChildren: 8
  };
}
