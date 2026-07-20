import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowDefinitionForAccess } from '../types/workflows.js';
import {
  createAgentDefinition,
  getAgentDefinition,
  updateAgentDefinition,
  type AgentDefinitionUpdate,
  type CreateAgentDefinitionInput
} from '../store/repository-agents.js';
import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  updateWorkflowDefinitionScope,
  type CreateWorkflowDefinitionInput,
  type WorkflowDefinitionUpdate
} from '../store/repository-workflows.js';
import { pruneTemplateInstallationRecordReference } from '../store/repository-automation-templates.js';
import { withTransaction } from '../store/repository-transaction.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import {
  recomputeWorkflowCoordinatorPolicy,
  resolveWorkflowRouting,
  type WorkflowCoordinatorFactory,
  WorkflowSelectionError,
  WORKFLOW_COORDINATOR_SYSTEM_ROLE
} from './workflow-coordinator.js';
import { reconcileTargetDiagnosticsForAgent } from './target-diagnostics-capability.js';

export type CreateWorkflowMutationInput = Omit<
  CreateWorkflowDefinitionInput,
  'entryAgentId' | 'delegationPolicy'
>;

export type WorkflowMutationUpdate = Omit<
  WorkflowDefinitionUpdate,
  'entryAgentId' | 'delegationPolicy'
>;

export class DefinitionValidationError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'DefinitionValidationError';
    this.code = code;
    this.details = details;
  }
}

function definedPatchKeys(patch: Record<string, unknown>): string[] {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function assertSystemAgentPatchAllowed(current: AgentDefinition, patch: AgentDefinitionUpdate): void {
  if (current.origin.type !== 'template') return;
  const definitionKeys = definedPatchKeys(patch as Record<string, unknown>)
    .filter((key) => key !== 'status');
  if (definitionKeys.length === 0) return;
  throw new DefinitionValidationError(
    'SYSTEM_AGENT_DEFINITION_IMMUTABLE',
    'System-provided Agent definitions cannot be edited. Duplicate this Agent to create an editable custom draft.',
    definitionKeys
  );
}

function assertSystemWorkflowPatchAllowed(current: WorkflowDefinitionForAccess, patch: WorkflowDefinitionUpdate): void {
  if (current.origin.type !== 'template') return;
  const definitionKeys = definedPatchKeys(patch as Record<string, unknown>)
    .filter((key) => key !== 'status')
    .filter((key) => {
      if (key !== 'agentIds' || !patch.agentIds) return true;
      return [...patch.agentIds].sort().join('\0') !== [...current.agentIds].sort().join('\0');
    });
  if (definitionKeys.length === 0) return;
  throw new DefinitionValidationError(
    'SYSTEM_WORKFLOW_DEFINITION_IMMUTABLE',
    'System-provided workflow definitions cannot be edited. Duplicate this workflow to create an editable custom draft.',
    definitionKeys
  );
}

function operationalResourceCount(input: Partial<CreateAgentDefinitionInput & AgentDefinitionUpdate>): number {
  return (input.mcpServers?.length || 0)
    + (input.mcpTools?.length || 0)
    + (input.mcpInstallations?.length || 0)
    + (input.tools?.length || 0)
    + (input.skills?.length || 0)
    + (input.skillInstallations?.length || 0)
    + (input.contextGrants?.length || 0);
}

async function validateAgentInput(
  input: CreateAgentDefinitionInput | (AgentDefinitionUpdate & { workspaceId: string }),
  current?: AgentDefinition,
  client?: PoolClient
): Promise<void> {
  const kind = input.kind || current?.kind || 'specialist';
  const effective = current ? { ...current, ...input } : input;
  const systemRole = 'systemRole' in effective ? effective.systemRole : current?.systemRole;
  if (kind === 'manager' && systemRole !== WORKFLOW_COORDINATOR_SYSTEM_ROLE) {
    throw new DefinitionValidationError(
      'MANAGER_SYSTEM_OWNED',
      'Managers are system-owned and cannot be created or configured directly.'
    );
  }
  if (kind === 'manager' && operationalResourceCount(effective) > 0) {
    throw new DefinitionValidationError(
      'MANAGER_OPERATIONAL_CAPABILITY_FORBIDDEN',
      'Managers can use coordination functions only.'
    );
  }
  if (kind === 'specialist' && (effective.delegateAgentIds?.length || 0) > 0) {
    throw new DefinitionValidationError(
      'SPECIALIST_DELEGATION_FORBIDDEN',
      'Only Managers may have a specialist allowlist.'
    );
  }
  if (kind === 'manager') {
    const delegateIds = effective.delegateAgentIds || [];
    const invalid: string[] = [];
    for (const agentId of delegateIds) {
      const candidate = await getAgentDefinition(input.workspaceId, agentId, client);
      if (!candidate || candidate.kind !== 'specialist') invalid.push(agentId);
    }
    if (invalid.length) {
      throw new DefinitionValidationError(
        'MANAGER_SPECIALIST_INVALID',
        'Manager allowlists may contain only existing specialist Agents.',
        invalid
      );
    }
  }
}

export async function createAgentThroughDefinitionService(input: CreateAgentDefinitionInput): Promise<AgentDefinition> {
  await validateAgentInput(input);
  const created = await createAgentDefinition(input);
  await reconcileTargetDiagnosticsForAgent(created);
  return (await refreshAgentReadiness(created.workspaceId, created.id)) || created;
}

export async function createAgentThroughDefinitionServiceInTransaction(
  client: PoolClient,
  input: CreateAgentDefinitionInput
): Promise<AgentDefinition> {
  await validateAgentInput(input, undefined, client);
  return createAgentDefinition(input, client);
}

function coordinatorFactory(client: PoolClient): WorkflowCoordinatorFactory {
  return (input) => createAgentThroughDefinitionServiceInTransaction(client, input);
}

export async function updateAgentThroughDefinitionService(
  workspaceId: string,
  agentId: string,
  patch: AgentDefinitionUpdate
): Promise<AgentDefinition | null> {
  const current = await getAgentDefinition(workspaceId, agentId);
  if (!current) return null;
  assertSystemAgentPatchAllowed(current, patch);
  await validateAgentInput({ ...patch, workspaceId }, current);
  const updated = await updateAgentDefinition(workspaceId, agentId, patch);
  if (!updated) return null;
  await reconcileTargetDiagnosticsForAgent(updated);
  const refreshed = (await refreshAgentReadiness(workspaceId, agentId)) || updated;
  await Promise.all((await listWorkflowDefinitions(workspaceId))
    .filter((workflow) => workflow.agentIds.includes(agentId))
    .map((workflow) => refreshWorkflowReadiness(workflow)));
  return refreshed;
}

function definitionError(error: unknown): never {
  if (error instanceof WorkflowSelectionError) {
    throw new DefinitionValidationError(error.code, error.message, error.details);
  }
  throw error;
}

async function createWorkflowInTransaction(
  client: PoolClient,
  input: CreateWorkflowMutationInput
): Promise<WorkflowDefinitionForAccess> {
  try {
    const routing = await resolveWorkflowRouting(client, {
      workspaceId: input.workspaceId,
      agentIds: input.agentIds,
      capabilityPolicy: input.capabilityPolicy
    }, coordinatorFactory(client));
    const created = await createWorkflowDefinition({
      ...input,
      ...routing
    }, client);
    await recomputeWorkflowCoordinatorPolicy(client, input.workspaceId, coordinatorFactory(client));
    return created;
  } catch (error) {
    return definitionError(error);
  }
}

export async function createWorkflowThroughDefinitionService(input: CreateWorkflowMutationInput): Promise<WorkflowDefinitionForAccess> {
  const created = await withTransaction((client) => createWorkflowInTransaction(client, input));
  await refreshAgentReadiness(created.workspaceId, created.entryAgentId);
  return (await refreshWorkflowReadiness(created)) || created;
}

export async function createWorkflowThroughDefinitionServiceInTransaction(
  client: PoolClient,
  input: CreateWorkflowMutationInput
): Promise<WorkflowDefinitionForAccess> {
  return createWorkflowInTransaction(client, input);
}

export async function updateWorkflowThroughDefinitionService(
  workspaceId: string,
  workflowId: string,
  patch: WorkflowMutationUpdate
): Promise<WorkflowDefinitionForAccess | null> {
  const updated = await withTransaction(async (client) => {
    await client.query(
      'SELECT id FROM workflow_definitions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, workflowId]
    );
    const current = await getWorkflowDefinition(workspaceId, workflowId, client);
    if (!current) return null;
    assertSystemWorkflowPatchAllowed(current, patch);
    const capabilityPolicy = {
      ...current.capabilityPolicy,
      ...patch.capabilityPolicy
    };
    try {
      const routing = await resolveWorkflowRouting(client, {
        workspaceId,
        agentIds: patch.agentIds || current.agentIds,
        capabilityPolicy
      }, coordinatorFactory(client));
      const result = await updateWorkflowDefinitionScope(workspaceId, workflowId, {
        ...patch,
        ...routing,
        capabilityPolicy
      }, client);
      await recomputeWorkflowCoordinatorPolicy(client, workspaceId, coordinatorFactory(client));
      return result;
    } catch (error) {
      return definitionError(error);
    }
  });
  if (!updated) return null;
  await refreshAgentReadiness(updated.workspaceId, updated.entryAgentId);
  return refreshWorkflowReadiness(updated);
}

export async function deleteWorkflowThroughDefinitionService(
  workspaceId: string,
  workflowId: string
): Promise<'deleted' | 'not_found'> {
  const result = await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT id FROM workflow_definitions
       WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, workflowId]
    );
    if (!current.rowCount) return 'not_found' as const;
    await client.query(
      'DELETE FROM workflow_definitions WHERE workspace_id=$1 AND id=$2',
      [workspaceId, workflowId]
    );
    await pruneTemplateInstallationRecordReference(workspaceId, workflowId, client);
    await recomputeWorkflowCoordinatorPolicy(client, workspaceId, coordinatorFactory(client));
    return 'deleted' as const;
  });
  return result;
}

export async function refreshWorkflowCoordinationForWorkspace(workspaceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await recomputeWorkflowCoordinatorPolicy(client, workspaceId, coordinatorFactory(client));
  });
}
