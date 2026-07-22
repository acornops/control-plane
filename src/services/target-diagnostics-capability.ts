import { createHash } from 'node:crypto';
import { db } from '../infra/db.js';
import { logger } from '../logger.js';
import { incrementTargetDiagnosticsReconciliation } from '../metrics.js';
import {
  disablePlatformTargetAutomationMappings,
  upsertPlatformCapabilityRoutingMapping
} from '../store/repository-capability-routing.js';
import { repo } from '../store/repository.js';
import { listAgentDefinitions } from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import type { TargetSummary } from '../types/domain.js';
import type { McpToolConfig } from './mcp-registry-client.js';
import { listTargetMcpTools } from './mcp-registry-client.js';
import {
  TARGET_DIAGNOSTICS_READ_CAPABILITY,
  TARGET_REMEDIATION_WRITE_CAPABILITY,
  targetAllowedByAgentScope
} from './target-scope-authorization.js';

const PLATFORM_ACTOR = 'platform:target-diagnostics';

function mappingId(agentId: string, targetId: string, capabilityId: string): string {
  const prefix = capabilityId === TARGET_DIAGNOSTICS_READ_CAPABILITY ? 'target-diagnostics' : 'target-remediation';
  return `${prefix}-${createHash('sha256').update(`${agentId}\0${targetId}`).digest('hex').slice(0, 32)}`;
}

function eligibleAgent(agent: AgentDefinition, target: TargetSummary, capabilityId: string): boolean {
  return agent.kind === 'specialist'
    && agent.status === 'active'
    && agent.reviewState === 'reviewed'
    && agent.semanticCapabilityIds.includes(capabilityId)
    && targetAllowedByAgentScope(agent.targetScope, { id: target.id, targetType: target.targetType });
}

function builtInsForOperation(tools: McpToolConfig[], operation: 'read' | 'write') {
  return tools
    .filter((tool) => tool.source === 'builtin' && tool.enabled && tool.capability === operation && Boolean(tool.server_id))
    .map((tool) => ({
      serverId: tool.server_id,
      toolName: tool.name,
      alias: tool.name,
      operation
    }))
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function reconcileTargetDiagnosticsForTarget(
  target: TargetSummary,
  tools?: McpToolConfig[]
): Promise<{ activeMappings: number; disabledMappings: number; readToolCount: number; writeToolCount: number }> {
  const catalog = tools || await listTargetMcpTools(target.workspaceId, target.id, target.targetType);
  const readTools = builtInsForOperation(catalog, 'read');
  const targetRegistration = await repo.getTargetAgentRegistration(target.id);
  const writeTools = targetRegistration?.capabilities?.includes('write')
    ? builtInsForOperation(catalog, 'write')
    : [];
  const agents = await listAgentDefinitions(target.workspaceId, { includeInactive: true });
  const keepIds: string[] = [];
  for (const { capabilityId, targetTools } of [
    { capabilityId: TARGET_DIAGNOSTICS_READ_CAPABILITY, targetTools: readTools },
    { capabilityId: TARGET_REMEDIATION_WRITE_CAPABILITY, targetTools: writeTools }
  ]) {
    if (!targetTools.length) continue;
    for (const agent of agents.filter((candidate) => eligibleAgent(candidate, target, capabilityId))) {
      const id = mappingId(agent.id, target.id, capabilityId);
      keepIds.push(id);
      await upsertPlatformCapabilityRoutingMapping({
        id,
        workspaceId: target.workspaceId,
        capabilityId,
        agentId: agent.id,
        agentVersion: agent.version,
        status: 'active',
        reviewState: 'reviewed',
        priority: 10,
        targetTypes: [target.targetType],
        targetIds: [target.id],
        mcpTools: [],
        targetToolRefs: targetTools,
        nativeToolIds: [],
        invocationScopes: ['agent', 'workflow'],
        skillIds: [],
        contextGrants: [],
        createdBy: PLATFORM_ACTOR,
        reviewedBy: PLATFORM_ACTOR
      });
    }
  }
  const disabledMappings = await disablePlatformTargetAutomationMappings(target.workspaceId, target.id, keepIds);
  incrementTargetDiagnosticsReconciliation('success', keepIds.length, disabledMappings);
  logger.info({
    workspaceId: target.workspaceId,
    targetId: target.id,
    targetType: target.targetType,
    readToolCount: readTools.length,
    writeToolCount: writeTools.length,
    activeMappings: keepIds.length,
    disabledMappings
  }, 'Reconciled target diagnostics capability mappings');
  return { activeMappings: keepIds.length, disabledMappings, readToolCount: readTools.length, writeToolCount: writeTools.length };
}

export async function reconcileTargetDiagnosticsForAgent(agent: AgentDefinition): Promise<void> {
  if (!agent.semanticCapabilityIds.some((capabilityId) => (
    capabilityId === TARGET_DIAGNOSTICS_READ_CAPABILITY || capabilityId === TARGET_REMEDIATION_WRITE_CAPABILITY
  ))) return;
  const result = await db.query<{
    id: string; workspace_id: string; target_type: TargetSummary['targetType']; name: string;
    status: TargetSummary['status']; metadata: Record<string, unknown>; created_at: string; updated_at: string;
  }>(
    `SELECT id,workspace_id,target_type,name,status,metadata,created_at,updated_at
     FROM targets WHERE workspace_id=$1 ORDER BY id`,
    [agent.workspaceId]
  );
  for (const row of result.rows) {
    const target: TargetSummary = {
      id: row.id, workspaceId: row.workspace_id, targetType: row.target_type, name: row.name,
      status: row.status, metadata: row.metadata || {},
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
    };
    try {
      await reconcileTargetDiagnosticsForTarget(target);
    } catch (error) {
      incrementTargetDiagnosticsReconciliation('failure');
      logger.warn({ workspaceId: agent.workspaceId, agentId: agent.id, targetId: target.id, error }, 'Failed reconciling target diagnostics mapping for Agent');
    }
  }
}
