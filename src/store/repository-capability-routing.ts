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
    agentId: row.agent_id,
    status: row.status,
    reviewState: row.review_state,
    priority: row.priority,
    mcpTools: row.mcp_tools || [],
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
  'id' | 'createdAt' | 'updatedAt'
>): Promise<CapabilityRoutingMapping> {
  const result = await db.query<Row>(
    `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,agent_id,status,review_state,priority,
       mcp_tools,native_tool_ids,skill_ids,context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      input.workspaceId,
      randomUUID(),
      input.capabilityId,
      input.agentId,
      input.status,
      input.reviewState,
      input.priority,
      JSON.stringify(input.mcpTools),
      JSON.stringify(input.nativeToolIds),
      JSON.stringify(input.skillIds),
      JSON.stringify(input.contextGrants),
      input.createdBy,
      input.reviewedBy || null
    ]
  );
  return mapRow(result.rows[0]);
}

export async function markCapabilityMappingsForAgentReview(
  workspaceId: string,
  agentId: string,
  queryable: Pick<import('pg').PoolClient, 'query'> = db
): Promise<number> {
  const result = await queryable.query(
    `UPDATE capability_routing_mappings
     SET review_state='draft',reviewed_by=NULL,updated_at=NOW()
     WHERE workspace_id=$1 AND agent_id=$2 AND status='active' AND review_state='reviewed'`,
    [workspaceId, agentId]
  );
  return result.rowCount || 0;
}

export async function disableCapabilityMappingsForResource(
  workspaceId: string,
  predicate: { serverId?: string; skillId?: string; nativeToolId?: string }
): Promise<number> {
  const result = await db.query(
    `UPDATE capability_routing_mappings
     SET status='disabled',updated_at=NOW()
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
  'createdAt' | 'updatedAt'
>, queryable: Pick<import('pg').PoolClient, 'query'> = db): Promise<CapabilityRoutingMapping> {
  const result = await queryable.query<Row>(
    `INSERT INTO capability_routing_mappings (
       workspace_id,id,capability_id,agent_id,status,review_state,priority,
       mcp_tools,native_tool_ids,skill_ids,
       context_grants,created_by,reviewed_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (workspace_id,id) DO UPDATE SET
       capability_id=EXCLUDED.capability_id,
       agent_id=EXCLUDED.agent_id,
       status=EXCLUDED.status,
       review_state=EXCLUDED.review_state,
       priority=EXCLUDED.priority,
       mcp_tools=EXCLUDED.mcp_tools,
       native_tool_ids=EXCLUDED.native_tool_ids,
       skill_ids=EXCLUDED.skill_ids,
       context_grants=EXCLUDED.context_grants,
       reviewed_by=EXCLUDED.reviewed_by,
       updated_at=NOW()
     RETURNING *`,
    [
      input.workspaceId, input.id, input.capabilityId, input.agentId,
      input.status, input.reviewState, input.priority, JSON.stringify(input.mcpTools),
      JSON.stringify(input.nativeToolIds), JSON.stringify(input.skillIds),
      JSON.stringify(input.contextGrants), input.createdBy, input.reviewedBy || null
    ]
  );
  return mapRow(result.rows[0]);
}
