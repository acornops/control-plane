import type { PoolClient } from 'pg';
import { getAgentDefinition } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { WorkflowCapabilityPolicy } from '../types/workflows.js';
import { incrementWorkflowRoutingOutcome } from '../metrics.js';
import { capabilitiesOutsideAgentCeiling } from './workflow-capability-policy.js';

export const WORKFLOW_COORDINATOR_PROFILE_VERSION = 1;
export const WORKFLOW_COORDINATOR_INSTRUCTIONS =
  'Coordinate this Workflow by delegating each required semantic capability and exact target to a specialist. '
  + 'Use only the AcornOps delegation functions, wait for every child to finish, and synthesize the final answer from successful specialist results.';

interface WorkflowRoutingSelection {
  agentIds: string[];
  selectedAgents: AgentDefinition[];
}

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

export async function resolveWorkflowRouting(
  client: PoolClient,
  input: {
    workspaceId: string;
    agentIds: string[];
    capabilityPolicy: Pick<WorkflowCapabilityPolicy, 'restrictionMode' | 'semanticCapabilityIds'>;
  }
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
    if (!agent || agent.workspaceId !== input.workspaceId
      || agent.status !== 'active' || agent.reviewState !== 'reviewed') {
      incrementWorkflowRoutingOutcome(requestedMode, 'failure');
      throw new WorkflowSelectionError(
        'WORKFLOW_AGENT_SELECTION_INVALID',
        'Every selected Agent must be active, reviewed, and in this workspace.',
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

  incrementWorkflowRoutingOutcome(requestedMode, 'success');
  return { agentIds, selectedAgents };
}
