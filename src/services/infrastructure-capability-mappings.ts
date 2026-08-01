import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import {
  disablePlatformTargetsMcpMappingsForAgent,
  upsertPlatformCapabilityRoutingMapping
} from '../store/repository-capability-routing.js';
import type { AgentDefinition } from '../types/agents.js';
import {
  INFRASTRUCTURE_DIAGNOSTICS_READ_CAPABILITY,
  INFRASTRUCTURE_REMEDIATION_WRITE_CAPABILITY
} from './targets-mcp.js';
import { targetsMcpToolRefs } from './targets-mcp-catalog.js';

const PLATFORM_ACTOR = 'platform:targets-mcp';
const INFRASTRUCTURE_CAPABILITIES = [
  INFRASTRUCTURE_DIAGNOSTICS_READ_CAPABILITY,
  INFRASTRUCTURE_REMEDIATION_WRITE_CAPABILITY
] as const;

function mappingId(agentId: string, capabilityId: string): string {
  const prefix = capabilityId === INFRASTRUCTURE_DIAGNOSTICS_READ_CAPABILITY
    ? 'infrastructure-diagnostics'
    : 'infrastructure-remediation';
  return `${prefix}-${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`;
}

/**
 * Materialize stable platform capability mappings from Agent configuration.
 * The mapping contains only generic Targets MCP references; it never inspects
 * or stores workspace target identity, inventory, or connector state.
 */
export async function reconcileInfrastructureCapabilityMappingsForAgent(
  agent: AgentDefinition,
  queryable: Pick<PoolClient, 'query'> = db
): Promise<void> {
  const keepIds: string[] = [];
  for (const capabilityId of INFRASTRUCTURE_CAPABILITIES) {
    if (!agent.semanticCapabilityIds.includes(capabilityId)) continue;
    const id = mappingId(agent.id, capabilityId);
    keepIds.push(id);
    const operation = capabilityId === INFRASTRUCTURE_DIAGNOSTICS_READ_CAPABILITY ? 'read' : 'write';
    await upsertPlatformCapabilityRoutingMapping({
      id,
      workspaceId: agent.workspaceId,
      capabilityId,
      agentId: agent.id,
      status: 'active',
      reviewState: 'reviewed',
      priority: 10,
      mcpTools: targetsMcpToolRefs(operation),
      nativeToolIds: [],
      skillIds: [],
      contextGrants: [],
      createdBy: PLATFORM_ACTOR,
      reviewedBy: PLATFORM_ACTOR
    }, queryable);
  }
  await disablePlatformTargetsMcpMappingsForAgent(agent.workspaceId, agent.id, keepIds, queryable);
}
