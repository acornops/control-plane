import type { PoolClient } from 'pg';
import { getAgentDefinition, type CreateAgentDefinitionInput } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowCapabilityPolicy, WorkflowDelegationPolicy } from '../types/workflows.js';
import { incrementWorkflowRoutingOutcome } from '../metrics.js';
import { DEFAULT_MAX_CONCURRENT_DELEGATIONS, DEFAULT_MAX_DELEGATIONS } from './coordination-functions.js';
import { capabilitiesOutsideAgentCeiling } from './workflow-capability-policy.js';

export const WORKFLOW_COORDINATOR_SYSTEM_ROLE = 'workflow_coordinator' as const;

interface WorkflowRoutingSelection {
  agentIds: string[];
  entryAgentId: string;
  delegationPolicy?: WorkflowDelegationPolicy;
  coordinator?: AgentDefinition;
}

export type WorkflowCoordinatorFactory = (
  input: CreateAgentDefinitionInput
) => Promise<AgentDefinition>;

export class WorkflowSelectionError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'WorkflowSelectionError';
    this.code = code;
    this.details = details;
  }
}

function normalizedAgentIds(agentIds: string[]): string[] {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    throw new WorkflowSelectionError(
      'WORKFLOW_AGENT_SELECTION_REQUIRED',
      'Select at least one specialist Agent.'
    );
  }
  const trimmed = agentIds.map((agentId) => agentId.trim());
  if (trimmed.some((agentId) => !agentId)) {
    throw new WorkflowSelectionError(
      'WORKFLOW_AGENT_SELECTION_INVALID',
      'agentIds must contain only non-empty Agent IDs.'
    );
  }
  if (new Set(trimmed).size !== trimmed.length) {
    throw new WorkflowSelectionError(
      'WORKFLOW_AGENT_SELECTION_DUPLICATE',
      'agentIds must contain unique Agent IDs.'
    );
  }
  return [...trimmed].sort((left, right) => left.localeCompare(right));
}

export async function getWorkflowCoordinator(
  client: PoolClient,
  workspaceId: string
): Promise<AgentDefinition | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM agent_definitions
     WHERE workspace_id=$1 AND system_role=$2`,
    [workspaceId, WORKFLOW_COORDINATOR_SYSTEM_ROLE]
  );
  return result.rowCount
    ? getAgentDefinition(workspaceId, result.rows[0].id, client)
    : null;
}

export async function ensureWorkflowCoordinator(
  client: PoolClient,
  workspaceId: string,
  createCoordinator: WorkflowCoordinatorFactory
): Promise<AgentDefinition> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `workflow-coordinator:${workspaceId}`
  ]);
  const existing = await getWorkflowCoordinator(client, workspaceId);
  if (existing) return existing;

  const workspace = await client.query<{ created_by: string }>(
    'SELECT created_by FROM workspaces WHERE id=$1',
    [workspaceId]
  );
  if (!workspace.rowCount) {
    throw new WorkflowSelectionError('WORKSPACE_NOT_FOUND', 'Workspace not found.');
  }
  return createCoordinator({
    workspaceId,
    name: 'AcornOps workflow coordinator',
    description: 'Internal coordination infrastructure.',
    instructions: 'Choose the required reviewed capability and exact target, then delegate through coordination functions only.',
    ownerUserId: workspace.rows[0].created_by,
    createdBy: workspace.rows[0].created_by,
    origin: { type: 'template', templateId: 'workflow-coordinator', templateVersion: 1 },
    kind: 'manager',
    systemRole: WORKFLOW_COORDINATOR_SYSTEM_ROLE,
    reviewState: 'reviewed',
    providerType: 'internal',
    targetScope: { type: 'workspace' },
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes',
    semanticCapabilityIds: [],
    delegateAgentIds: []
  });
}

export async function resolveWorkflowRouting(
  client: PoolClient,
  input: {
    workspaceId: string;
    agentIds: string[];
    capabilityPolicy: Pick<WorkflowCapabilityPolicy, 'restrictionMode' | 'semanticCapabilityIds'>;
  },
  createCoordinator: WorkflowCoordinatorFactory
): Promise<WorkflowRoutingSelection> {
  const requestedMode = input.agentIds.length > 1 ? 'coordinated' : 'direct';
  let agentIds: string[];
  try {
    agentIds = normalizedAgentIds(input.agentIds);
  } catch (error) {
    incrementWorkflowRoutingOutcome(requestedMode, 'failure');
    throw error;
  }
  const selectedAgents: AgentDefinition[] = [];
  for (const agentId of agentIds) {
    const agent = await getAgentDefinition(input.workspaceId, agentId, client);
    if (agent?.kind === 'manager' || agent?.systemRole) {
      incrementWorkflowRoutingOutcome(requestedMode, 'failure');
      throw new WorkflowSelectionError(
        'MANAGER_SYSTEM_OWNED',
        'Managers are system-owned and cannot be selected or accessed directly.',
        [agentId]
      );
    }
    if (!agent || agent.workspaceId !== input.workspaceId || agent.kind !== 'specialist'
      || agent.status !== 'active' || agent.reviewState !== 'reviewed') {
      incrementWorkflowRoutingOutcome(requestedMode, 'failure');
      throw new WorkflowSelectionError(
        'WORKFLOW_AGENT_SELECTION_INVALID',
        'Every selected Agent must be an active, reviewed specialist in this workspace.',
        [agentId]
      );
    }
    selectedAgents.push(agent);
  }

  const outsideCeiling = capabilitiesOutsideAgentCeiling(input.capabilityPolicy, selectedAgents);
  if (outsideCeiling.length > 0) {
    incrementWorkflowRoutingOutcome(requestedMode, 'failure');
    throw new WorkflowSelectionError(
      'WORKFLOW_CAPABILITY_OUTSIDE_AGENT_CEILING',
      'Workflow capabilities must be a subset of the selected Agents’ combined ceiling.',
      outsideCeiling
    );
  }

  const coordinator = await ensureWorkflowCoordinator(client, input.workspaceId, createCoordinator);
  if (agentIds.length === 1) {
    incrementWorkflowRoutingOutcome('direct', 'success');
    return { agentIds, entryAgentId: agentIds[0], coordinator };
  }
  incrementWorkflowRoutingOutcome('coordinated', 'success');
  return {
    agentIds,
    entryAgentId: coordinator.id,
    delegationPolicy: {
      specialistAgentIds: agentIds,
      maxConcurrentChildren: DEFAULT_MAX_CONCURRENT_DELEGATIONS,
      maxChildren: DEFAULT_MAX_DELEGATIONS
    },
    coordinator
  };
}

export async function recomputeWorkflowCoordinatorPolicy(
  client: PoolClient,
  workspaceId: string,
  createCoordinator: WorkflowCoordinatorFactory
): Promise<{ coordinator: AgentDefinition; changed: boolean }> {
  const coordinator = await ensureWorkflowCoordinator(client, workspaceId, createCoordinator);
  const policy = await client.query<{ agent_ids: string[]; capability_ids: string[] }>(
    `SELECT
       COALESCE((
         SELECT jsonb_agg(agent_id ORDER BY agent_id)
         FROM (
           SELECT DISTINCT jsonb_array_elements_text(agent_ids) AS agent_id
           FROM workflow_definitions
           WHERE workspace_id=$1 AND jsonb_array_length(agent_ids)>1
         ) selected_agents
       ), '[]'::jsonb) AS agent_ids,
       COALESCE((
         SELECT jsonb_agg(capability_id ORDER BY capability_id)
         FROM (
           SELECT DISTINCT jsonb_array_elements_text(
             CASE WHEN workflow.capability_policy->>'restrictionMode'='inherit'
                  THEN agent.semantic_capability_ids
                  ELSE workflow.capability_policy->'semanticCapabilityIds' END
           ) AS capability_id
           FROM workflow_definitions workflow
           JOIN agent_definitions agent ON agent.workspace_id=workflow.workspace_id
             AND agent.id IN (SELECT jsonb_array_elements_text(workflow.agent_ids))
           WHERE workflow.workspace_id=$1 AND jsonb_array_length(workflow.agent_ids)>1
         ) selected_capabilities
       ), '[]'::jsonb) AS capability_ids`,
    [workspaceId]
  );
  const derived = policy.rows[0];
  const update = await client.query<{ id: string }>(
    `UPDATE agent_definitions
     SET delegate_agent_ids=$3,
         semantic_capability_ids=$4,
         version=version+1,
         readiness_status='needs_setup',
         readiness_reasons=$5,
         updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2
       AND (delegate_agent_ids IS DISTINCT FROM $3::jsonb
         OR semantic_capability_ids IS DISTINCT FROM $4::jsonb)
     RETURNING id`,
    [
      workspaceId,
      coordinator.id,
      JSON.stringify(derived.agent_ids),
      JSON.stringify(derived.capability_ids),
      JSON.stringify(['Coordinator readiness must be evaluated against current reviewed mappings.'])
    ]
  );
  return {
    coordinator: (await getAgentDefinition(workspaceId, coordinator.id, client)) || coordinator,
    changed: Boolean(update.rowCount)
  };
}
