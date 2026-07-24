import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';

type Row = QueryResultRow;
const iso = (value: unknown): string => new Date(value as string).toISOString();

function mapRow(row: Row): CapabilityRoutingMapping {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    capabilityId: row.capability_id,
    version: row.version,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    status: row.status,
    reviewState: row.review_state,
    priority: row.priority,
    targetTypes: row.target_types || [],
    targetIds: row.target_ids || [],
    mcpTools: row.mcp_tools || [],
    targetToolRefs: row.target_tool_refs || [],
    nativeToolIds: row.native_tool_ids || [],
    skillIds: row.skill_ids || [],
    contextGrants: row.context_grants || [],
    createdBy: row.created_by,
    reviewedBy: row.reviewed_by || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function listCapabilityRoutingMappings(
  workspaceId: string,
  options: { activeReviewedOnly?: boolean; capabilityIds?: string[] } = {}
): Promise<CapabilityRoutingMapping[]> {
  const filters = ['workspace_id=$1'];
  const values: unknown[] = [workspaceId];
  if (options.activeReviewedOnly) {
    filters.push("status='active'", "review_state='reviewed'");
  }
  if (options.capabilityIds?.length) {
    values.push(options.capabilityIds);
    filters.push(`capability_id=ANY($${values.length}::text[])`);
  }
  const result = await db.query<Row>(
    `SELECT * FROM capability_routing_mappings
     WHERE ${filters.join(' AND ')}
     ORDER BY capability_id,priority,id`,
    values
  );
  return result.rows.map(mapRow);
}

export async function createCapabilityRoutingMapping(input: Omit<
  CapabilityRoutingMapping,
  'id' | 'version' | 'createdAt' | 'updatedAt' | 'targetToolRefs'
> & { targetToolRefs?: CapabilityRoutingMapping['targetToolRefs'] }): Promise<CapabilityRoutingMapping> {
  const result = await db.query<Row>(
    `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,version,agent_id,agent_version,status,review_state,priority,
       target_types,target_ids,mcp_tools,target_tool_refs,native_tool_ids,skill_ids,context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [
      input.workspaceId,
      randomUUID(),
      input.capabilityId,
      input.agentId,
      input.agentVersion,
      input.status,
      input.reviewState,
      input.priority,
      JSON.stringify(input.targetTypes),
      JSON.stringify(input.targetIds),
      JSON.stringify(input.mcpTools),
      JSON.stringify(input.targetToolRefs || []),
      JSON.stringify(input.nativeToolIds),
      JSON.stringify(input.skillIds),
      JSON.stringify(input.contextGrants),
      input.createdBy,
      input.reviewedBy || null
    ]
  );
  return mapRow(result.rows[0]);
}

export async function rebindCapabilityMappingsForAgent(
  workspaceId: string,
  agentId: string,
  agentVersion: number,
  queryable: Pick<import('pg').PoolClient, 'query'> = db
): Promise<number> {
  const result = await queryable.query(
    `UPDATE capability_routing_mappings
     SET agent_version=$3,version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND agent_id=$2 AND status='active'`,
    [workspaceId, agentId, agentVersion]
  );
  return result.rowCount || 0;
}

export async function disableCapabilityMappingsForResource(
  workspaceId: string,
  predicate: { serverId?: string; skillId?: string; nativeToolId?: string }
): Promise<number> {
  const result = await db.query(
    `UPDATE capability_routing_mappings
     SET status='disabled',version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND status='active' AND (
       ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(mcp_tools) ref WHERE ref->>'serverId'=$2))
       OR ($3::text IS NOT NULL AND skill_ids ? $3)
       OR ($4::text IS NOT NULL AND native_tool_ids ? $4)
     )`,
    [workspaceId, predicate.serverId || null, predicate.skillId || null, predicate.nativeToolId || null]
  );
  return result.rowCount || 0;
}

export async function upsertPlatformCapabilityRoutingMapping(input: Omit<
  CapabilityRoutingMapping,
  'version' | 'createdAt' | 'updatedAt'
>): Promise<CapabilityRoutingMapping> {
  const result = await db.query<Row>(
    `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,version,agent_id,agent_version,status,review_state,priority,
       target_types,target_ids,mcp_tools,target_tool_refs,native_tool_ids,skill_ids,
       context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (workspace_id,id) DO UPDATE SET
       capability_id=EXCLUDED.capability_id,
       agent_id=EXCLUDED.agent_id,
       agent_version=EXCLUDED.agent_version,
       status=EXCLUDED.status,
       review_state=EXCLUDED.review_state,
       priority=EXCLUDED.priority,
       target_types=EXCLUDED.target_types,
       target_ids=EXCLUDED.target_ids,
       mcp_tools=EXCLUDED.mcp_tools,
       target_tool_refs=EXCLUDED.target_tool_refs,
       native_tool_ids=EXCLUDED.native_tool_ids,
       skill_ids=EXCLUDED.skill_ids,
       context_grants=EXCLUDED.context_grants,
       reviewed_by=EXCLUDED.reviewed_by,
       version=capability_routing_mappings.version+1,
       updated_at=NOW()
     RETURNING *`,
    [
      input.workspaceId, input.id, input.capabilityId, input.agentId, input.agentVersion,
      input.status, input.reviewState, input.priority, JSON.stringify(input.targetTypes),
      JSON.stringify(input.targetIds), JSON.stringify(input.mcpTools), JSON.stringify(input.targetToolRefs),
      JSON.stringify(input.nativeToolIds), JSON.stringify(input.skillIds),
      JSON.stringify(input.contextGrants), input.createdBy, input.reviewedBy || null
    ]
  );
  return mapRow(result.rows[0]);
}

export async function disablePlatformTargetAutomationMappings(
  workspaceId: string,
  targetId: string,
  keepIds: string[]
): Promise<number> {
  const result = await db.query(
    `UPDATE capability_routing_mappings
     SET status='disabled',version=version+1,updated_at=NOW()
     WHERE workspace_id=$1 AND capability_id=ANY($4::text[])
       AND target_ids ? $2 AND created_by='platform:target-diagnostics'
       AND NOT (id=ANY($3::text[])) AND status='active'`,
    [workspaceId, targetId, keepIds, ['target.diagnostics.read', 'target.remediation.write']]
  );
  return result.rowCount || 0;
}

export const disablePlatformTargetDiagnosticMappings = disablePlatformTargetAutomationMappings;
