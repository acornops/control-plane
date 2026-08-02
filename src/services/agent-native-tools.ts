import { insertWorkspaceAuditEvent } from '../store/repository-audit-events.js';
import { getAgentDefinition } from '../store/repository-agents.js';
import { listWorkflowDefinitions } from '../store/repository-workflows.js';
import { withTransaction } from '../store/repository-transaction.js';
import type { AgentDefinition } from '../types/agents.js';
import { refreshAgentReadiness, refreshWorkflowReadiness } from './automation-readiness.js';
import { refreshWorkflowCoordinationForWorkspace } from './automation-definition-service.js';
import {
  FETCH_TOOL_ID,
  FetchUrlPolicyError,
  normalizeFetchToolConfig
} from './fetch-url-policy.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';

export class AgentNativeToolAssignmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentNativeToolAssignmentError';
  }
}

function mappingId(agentId: string, toolId: string): string {
  return `native:${agentId}:${toolId}`;
}

export async function setAgentNativeToolAssignment(input: {
  workspaceId: string;
  agentId: string;
  toolId: string;
  assigned: boolean;
  actorUserId: string;
  config?: unknown;
}): Promise<AgentDefinition> {
  const tool = getWorkspaceNativeTool(input.toolId);
  if (!tool) throw new AgentNativeToolAssignmentError('NATIVE_TOOL_NOT_FOUND', 'Native tool not found.');
  let normalizedConfig: Record<string, unknown> | undefined;
  try {
    if (tool.id === FETCH_TOOL_ID && input.assigned) {
      normalizedConfig = normalizeFetchToolConfig(input.config) as unknown as Record<string, unknown>;
    } else if (input.config !== undefined) {
      throw new FetchUrlPolicyError(
        'NATIVE_TOOL_CONFIG_UNSUPPORTED',
        'This native tool does not accept configuration.'
      );
    }
  } catch (error) {
    if (error instanceof FetchUrlPolicyError) {
      throw new AgentNativeToolAssignmentError('NATIVE_TOOL_CONFIG_INVALID', error.message);
    }
    throw error;
  }

  const changed = await withTransaction(async (client) => {
    const locked = await client.query<{
      tools: string[];
      native_tool_configs: Record<string, Record<string, unknown>>;
      semantic_capability_ids: string[];
    }>(
      `SELECT tools,native_tool_configs,semantic_capability_ids FROM agent_definitions
       WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.agentId]
    );
    if (!locked.rowCount) throw new AgentNativeToolAssignmentError('AGENT_NOT_FOUND', 'Agent not found.');
    const row = locked.rows[0];
    const assigned = new Set(row.tools || []);
    const nativeToolConfigs = structuredClone(row.native_tool_configs || {});
    const capabilities = new Set(row.semantic_capability_ids || []);
    const alreadyAssigned = assigned.has(tool.id);
    const currentConfig = nativeToolConfigs[tool.id];
    const configChanged = JSON.stringify(currentConfig) !== JSON.stringify(normalizedConfig);
    if (alreadyAssigned === input.assigned
      && (input.assigned ? !configChanged : currentConfig === undefined)) return false;
    if (input.assigned) {
      assigned.add(tool.id);
      capabilities.add(tool.semanticCapabilityId);
      if (normalizedConfig) nativeToolConfigs[tool.id] = normalizedConfig;
    } else {
      assigned.delete(tool.id);
      capabilities.delete(tool.semanticCapabilityId);
      delete nativeToolConfigs[tool.id];
    }
    await client.query(
      `UPDATE agent_definitions
       SET tools=$3,native_tool_configs=$4,semantic_capability_ids=$5,
           readiness_status='needs_setup',readiness_reasons=$6,
           updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
       WHERE workspace_id=$1 AND id=$2`,
      [input.workspaceId, input.agentId, JSON.stringify([...assigned].sort()),
       JSON.stringify(nativeToolConfigs), JSON.stringify([...capabilities].sort()),
       JSON.stringify(['Native-tool capability mappings changed and readiness is being recomputed.'])]
    );
    if (input.assigned && !alreadyAssigned) {
      await client.query(
        `INSERT INTO capability_routing_mappings (
           workspace_id,id,capability_id,agent_id,status,review_state,priority,
           mcp_tools,native_tool_ids,skill_ids,created_by,reviewed_by
         ) VALUES ($1,$2,$3,$4,'active','reviewed',100,'[]',$5,'[]',$6,$6)
         ON CONFLICT (workspace_id,id) DO UPDATE SET
           capability_id=EXCLUDED.capability_id,status='active',review_state='reviewed',
           native_tool_ids=EXCLUDED.native_tool_ids,
           reviewed_by=EXCLUDED.reviewed_by,
           updated_at=NOW()`,
        [input.workspaceId, mappingId(input.agentId, tool.id), tool.semanticCapabilityId,
         input.agentId, JSON.stringify([tool.id]), input.actorUserId]
      );
    } else if (!input.assigned) {
      await client.query(
        `UPDATE capability_routing_mappings
         SET status='disabled',updated_at=NOW()
         WHERE workspace_id=$1 AND agent_id=$2 AND native_tool_ids ? $3`,
        [input.workspaceId, input.agentId, tool.id]
      );
    }
    await client.query(
      `UPDATE workflow_definitions
       SET readiness_status='needs_setup',readiness_reasons=$3,
           updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
       WHERE workspace_id=$1 AND agent_ids ? $2`,
      [input.workspaceId, input.agentId,
       JSON.stringify(['A selected Agent capability changed and workflow readiness is being recomputed.'])]
    );
    await insertWorkspaceAuditEvent({
      workspaceId: input.workspaceId,
      category: 'tool',
      eventType: input.assigned
        ? alreadyAssigned ? 'agent.native_tool_config_updated.v1' : 'agent.native_tool_granted.v1'
        : 'agent.native_tool_revoked.v1',
      operation: 'write',
      actorUserId: input.actorUserId,
      objectType: 'agent_native_tool',
      objectId: `${input.agentId}:${tool.id}`,
      objectName: tool.title,
      summary: input.assigned
        ? alreadyAssigned ? 'Agent native tool configuration updated' : 'Agent native tool granted'
        : 'Agent native tool revoked',
      metadata: {
        agentId: input.agentId,
        toolId: tool.id,
        ...(tool.id === FETCH_TOOL_ID && input.assigned
          ? { configuredPatternCount: (normalizedConfig?.allowedUrlPatterns as unknown[]).length }
          : {})
      }
    }, client);
    return true;
  });

  if (changed) {
    await refreshWorkflowCoordinationForWorkspace(input.workspaceId);
    await refreshAgentReadiness(input.workspaceId, input.agentId);
    for (const workflow of (await listWorkflowDefinitions(input.workspaceId)).filter((item) => item.agentIds.includes(input.agentId))) {
      await refreshWorkflowReadiness(workflow);
    }
  }
  const agent = await getAgentDefinition(input.workspaceId, input.agentId);
  if (!agent) throw new AgentNativeToolAssignmentError('AGENT_NOT_FOUND', 'Agent not found.');
  return agent;
}
