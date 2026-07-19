import type { AgentDefinition } from '../types/agents.js';
import type { TargetType } from '../types/domain.js';

export class CatalogDestinationValidationError extends Error {
  readonly code = 'AGENT_MCP_TARGET_CONSTRAINT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'CatalogDestinationValidationError';
  }
}

export async function validateAgentCatalogDestination(input: {
  agent: AgentDefinition;
  targetConstraints: { targetTypes: TargetType[]; targetIds: string[] };
  findTarget: (workspaceId: string, targetId: string) => Promise<{ targetType: TargetType } | null>;
}): Promise<void> {
  const { agent, targetConstraints } = input;
  const permittedTargetTypes = agent.targetScope.targetTypes ?? [];
  const permittedTargetIds = agent.targetScope.targetIds ?? [];
  if (agent.kind === 'manager') {
    throw new CatalogDestinationValidationError('Managers can use coordination functions only.');
  }
  if (permittedTargetTypes.length
    && targetConstraints.targetTypes.some((type) => !permittedTargetTypes.includes(type))) {
    throw new CatalogDestinationValidationError('MCP target type constraints must stay within the Agent target scope.');
  }
  if (permittedTargetIds.length
    && targetConstraints.targetIds.some((id) => !permittedTargetIds.includes(id))) {
    throw new CatalogDestinationValidationError('MCP target ID constraints must stay within the Agent target scope.');
  }
  for (const targetId of targetConstraints.targetIds) {
    const target = await input.findTarget(agent.workspaceId, targetId);
    if (!target) {
      throw new CatalogDestinationValidationError(`Unknown target ID: ${targetId}`);
    }
    if (targetConstraints.targetTypes.length && !targetConstraints.targetTypes.includes(target.targetType)) {
      throw new CatalogDestinationValidationError(
        `Target ${targetId} has type ${target.targetType}, which is outside the MCP target type constraints.`
      );
    }
  }
}
