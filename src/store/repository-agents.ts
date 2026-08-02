import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { AgentDefinition } from '../types/agents.js';
import { markCapabilityMappingsForAgentReview } from './repository-capability-routing.js';
import type {
  AgentDefinitionUpdate,
  CreateAgentDefinitionInput
} from './repository-agent-types.js';
import { withTransaction } from './repository-transaction.js';

export type {
  AgentDefinitionUpdate,
  CreateAgentDefinitionInput
} from './repository-agent-types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function slug(value: string, fallback: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || fallback;
}

function capabilityConfiguration(agent: AgentDefinition): unknown {
  return {
    mcpServers: agent.mcpServers,
    mcpTools: agent.mcpTools,
    mcpInstallations: agent.mcpInstallations,
    tools: agent.tools,
    nativeToolConfigs: agent.nativeToolConfigs,
    skills: agent.skills,
    skillInstallations: agent.skillInstallations,
    semanticCapabilityIds: agent.semanticCapabilityIds
  };
}

type AgentRow = QueryResultRow;
type Queryable = Pick<PoolClient, 'query'>;
const iso = (value: unknown): string | undefined => value ? new Date(value as string).toISOString() : undefined;

async function mapAgent(row: AgentRow): Promise<AgentDefinition> {
  const agent: AgentDefinition = {
    id: row.id, workspaceId: row.workspace_id, name: row.name, avatarEmoji: row.avatar_emoji || '🤖', description: row.description || undefined,
    instructions: row.instructions, status: row.status,
    reviewState: row.review_state || 'reviewed',
    providerType: row.provider_type, ownerUserId: row.owner_user_id,
    createdBy: row.created_by, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    mcpServers: row.mcp_servers || [], mcpTools: row.mcp_tools || [],
    mcpInstallations: row.mcp_installations || [], tools: row.tools || [],
    nativeToolConfigs: row.native_tool_configs || {}, skills: row.skills || [],
    skillInstallations: row.skill_installations || [],
    approvalPolicy: row.approval_policy, trustPolicy: row.trust_policy,
    permissionMode: row.permission_mode || 'ask_before_changes',
    semanticCapabilityIds: row.semantic_capability_ids || [],
    readiness: { status: row.readiness_status || 'needs_setup', reasons: row.readiness_reasons || [] }
  };
  return agent;
}

export async function listAgentDefinitions(workspaceId: string, options: { includeInactive?: boolean } = {}): Promise<AgentDefinition[]> {
  const result = await db.query<AgentRow>(
    `SELECT agent.*
     FROM agent_definitions agent
     WHERE agent.workspace_id=$1 ${options.includeInactive ? '' : "AND agent.status='active'"}
     ORDER BY agent.updated_at DESC,agent.id`,
    [workspaceId]
  );
  return Promise.all(result.rows.map((row) => mapAgent(row)));
}

export async function listAgentDefinitionRefs(): Promise<Array<{ workspaceId: string; agentId: string }>> {
  const result = await db.query<{ workspace_id: string; id: string }>(
    `SELECT workspace_id,id
     FROM agent_definitions
     WHERE status='active'
     ORDER BY workspace_id,id`
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, agentId: row.id }));
}

export async function getAgentDefinition(
  workspaceId: string,
  agentId: string,
  queryable: Queryable = db
): Promise<AgentDefinition | null> {
  const result = await queryable.query<AgentRow>(
    `SELECT agent.*
     FROM agent_definitions agent
     WHERE agent.workspace_id=$1 AND agent.id=$2`,
    [workspaceId, agentId]
  );
  return result.rowCount ? mapAgent(result.rows[0]) : null;
}

export async function deleteAgentDefinition(workspaceId: string, agentId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM agent_definitions WHERE workspace_id=$1 AND id=$2', [workspaceId, agentId]);
  return Boolean(result.rowCount);
}

export async function createAgentDefinition(
  input: CreateAgentDefinitionInput,
  queryable: Queryable = db
): Promise<AgentDefinition> {
  const id = `agent-${slug(input.name, 'custom')}-${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const agent: AgentDefinition = {
    id,
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    avatarEmoji: input.avatarEmoji || '🤖',
    description: input.description?.trim(),
    instructions: input.instructions.trim(),
    status: 'active',
    reviewState: input.reviewState || 'reviewed',
    providerType: input.providerType || 'internal',
    ownerUserId: input.ownerUserId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    mcpServers: uniqueSorted(input.mcpServers),
    mcpTools: input.mcpTools || [],
    mcpInstallations: input.mcpInstallations || [],
    tools: uniqueSorted(input.tools),
    nativeToolConfigs: structuredClone(input.nativeToolConfigs || {}),
    skills: uniqueSorted(input.skills),
    skillInstallations: input.skillInstallations || [],
    approvalPolicy: input.approvalPolicy || { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: input.trustPolicy || { level: 'restricted', allowExternalData: false },
    permissionMode: input.permissionMode || 'ask_before_changes',
    semanticCapabilityIds: uniqueSorted(input.semanticCapabilityIds),
    readiness: { status: 'needs_setup', reasons: ['Readiness has not been evaluated against the live capability catalog.'] }
  };
  const result = await queryable.query<AgentRow>(
    `INSERT INTO agent_definitions (
      workspace_id,id,name,description,instructions,status,review_state,provider_type,owner_user_id,created_by,
      mcp_servers,mcp_tools,mcp_installations,tools,native_tool_configs,skills,skill_installations,approval_policy,trust_policy,
      permission_mode,semantic_capability_ids,avatar_emoji,readiness_status,readiness_reasons
     ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'needs_setup',$22) RETURNING *`,
    [input.workspaceId, id, agent.name, agent.description || null, agent.instructions, agent.reviewState, agent.providerType,
     agent.ownerUserId, agent.createdBy, JSON.stringify(agent.mcpServers), JSON.stringify(agent.mcpTools), JSON.stringify(agent.mcpInstallations),
     JSON.stringify(agent.tools), JSON.stringify(agent.nativeToolConfigs), JSON.stringify(agent.skills), JSON.stringify(agent.skillInstallations),
     agent.approvalPolicy, agent.trustPolicy, agent.permissionMode, JSON.stringify(agent.semanticCapabilityIds), agent.avatarEmoji,
     JSON.stringify(agent.readiness.reasons)]
  );
  return mapAgent(result.rows[0]);
}

export async function duplicateAgentDefinition(
  workspaceId: string,
  agentId: string,
  createdBy: string,
  requestedName?: string
): Promise<AgentDefinition | null> {
  const source = await getAgentDefinition(workspaceId, agentId);
  if (!source) return null;
  const name = requestedName?.trim() || `${source.name} copy`;
  const id = `agent-${slug(name, 'custom')}-${randomUUID().slice(0, 8)}`;
  const installedSkillIds = new Set(source.skillInstallations.map((skill) => skill.id));
  const inheritedSkills = source.skills.filter((skill) => !installedSkillIds.has(skill));
  const result = await db.query<AgentRow>(
    `INSERT INTO agent_definitions (
       workspace_id,id,name,description,instructions,status,review_state,provider_type,
       owner_user_id,created_by,mcp_servers,mcp_tools,mcp_installations,tools,native_tool_configs,skills,skill_installations,
       approval_policy,trust_policy,permission_mode,semantic_capability_ids,avatar_emoji,readiness_status,readiness_reasons
     ) VALUES (
       $1,$2,$3,$4,$5,'draft','draft',$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       'needs_setup',$20
     ) RETURNING *`,
    [
      workspaceId,
      id,
      name,
      source.description || null,
      source.instructions,
      source.providerType,
      createdBy,
      '[]',
      '[]',
      '[]',
      JSON.stringify(uniqueSorted(source.tools)),
      JSON.stringify(source.nativeToolConfigs),
      JSON.stringify(uniqueSorted(inheritedSkills)),
      '[]',
      source.approvalPolicy,
      source.trustPolicy,
      source.permissionMode,
      JSON.stringify(source.semanticCapabilityIds),
      source.avatarEmoji,
      JSON.stringify(['Readiness has not been evaluated against the live capability catalog.'])
    ]
  );
  return mapAgent(result.rows[0]);
}

export async function updateAgentDefinition(workspaceId: string, agentId: string, patch: AgentDefinitionUpdate): Promise<AgentDefinition | null> {
  return withTransaction(async (client) => {
    const current = await getAgentDefinition(workspaceId, agentId, client);
    if (!current) return null;
    const updated: AgentDefinition = {
      ...current,
      name: patch.name?.trim() || current.name,
      avatarEmoji: patch.avatarEmoji || current.avatarEmoji,
      description: typeof patch.description === 'string' ? patch.description.trim() : current.description,
      instructions: patch.instructions?.trim() || current.instructions,
      status: patch.status || current.status,
      reviewState: patch.reviewState || current.reviewState,
      providerType: patch.providerType || current.providerType,
      ownerUserId: patch.ownerUserId || current.ownerUserId,
      mcpServers: patch.mcpServers ? uniqueSorted(patch.mcpServers) : current.mcpServers,
      mcpTools: patch.mcpTools || current.mcpTools,
      mcpInstallations: patch.mcpInstallations || current.mcpInstallations,
      tools: patch.tools ? uniqueSorted(patch.tools) : current.tools,
      nativeToolConfigs: patch.nativeToolConfigs
        ? structuredClone(patch.nativeToolConfigs)
        : current.nativeToolConfigs,
      skills: patch.skills ? uniqueSorted(patch.skills) : current.skills,
      skillInstallations: patch.skillInstallations || current.skillInstallations,
      approvalPolicy: patch.approvalPolicy || current.approvalPolicy,
      trustPolicy: patch.trustPolicy || current.trustPolicy,
      permissionMode: patch.permissionMode || current.permissionMode,
      semanticCapabilityIds: patch.semanticCapabilityIds ? uniqueSorted(patch.semanticCapabilityIds) : current.semanticCapabilityIds,
      updatedAt: nowIso()
    };
    const result = await client.query<AgentRow>(
      `UPDATE agent_definitions SET name=$3,description=$4,instructions=$5,status=$6,review_state=$7,provider_type=$8,
        owner_user_id=$9,mcp_servers=$10,mcp_tools=$11,mcp_installations=$12,tools=$13,native_tool_configs=$14,skills=$15,skill_installations=$16,
        approval_policy=$17,trust_policy=$18,permission_mode=$19,semantic_capability_ids=$20,avatar_emoji=$21,
        updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
       WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [workspaceId, agentId, updated.name, updated.description || null, updated.instructions, updated.status,
       updated.reviewState, updated.providerType, updated.ownerUserId, JSON.stringify(updated.mcpServers), JSON.stringify(updated.mcpTools),
       JSON.stringify(updated.mcpInstallations), JSON.stringify(updated.tools), JSON.stringify(updated.nativeToolConfigs), JSON.stringify(updated.skills), JSON.stringify(updated.skillInstallations),
       updated.approvalPolicy, updated.trustPolicy,
       updated.permissionMode, JSON.stringify(updated.semanticCapabilityIds), updated.avatarEmoji]
    );
    if (JSON.stringify(capabilityConfiguration(current)) !== JSON.stringify(capabilityConfiguration(updated))) {
      await markCapabilityMappingsForAgentReview(workspaceId, agentId, client);
    }
    return result.rowCount ? mapAgent(result.rows[0]) : null;
  });
}

export async function updateAgentSkillCapabilitySnapshot(
  workspaceId: string,
  agentId: string,
  skills: string[],
  skillInstallations: AgentDefinition['skillInstallations']
): Promise<AgentDefinition | null> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE agent_definitions
       SET skills=$3,skill_installations=$4,
           updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
       WHERE workspace_id=$1 AND id=$2
         AND (skills IS DISTINCT FROM $3::jsonb OR skill_installations IS DISTINCT FROM $4::jsonb)
       RETURNING id`,
      [workspaceId, agentId, JSON.stringify(uniqueSorted(skills)), JSON.stringify(skillInstallations)]
    );
    if (result.rowCount) await markCapabilityMappingsForAgentReview(workspaceId, agentId, client);
    return getAgentDefinition(workspaceId, agentId, client);
  });
}

export async function updateAgentMcpCapabilitySnapshot(
  workspaceId: string,
  agentId: string,
  snapshot: Pick<AgentDefinition, 'mcpServers' | 'mcpTools' | 'mcpInstallations'>,
  updatedBy: string
): Promise<AgentDefinition | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('acornops.actor_user_id', $1, true)`, [updatedBy]);
    const result = await client.query(
      `UPDATE agent_definitions
       SET mcp_servers=$3,mcp_tools=$4,mcp_installations=$5,
           updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
       WHERE workspace_id=$1 AND id=$2
         AND (mcp_servers IS DISTINCT FROM $3::jsonb OR mcp_tools IS DISTINCT FROM $4::jsonb
           OR mcp_installations IS DISTINCT FROM $5::jsonb)
       RETURNING id`,
      [workspaceId, agentId, JSON.stringify(snapshot.mcpServers), JSON.stringify(snapshot.mcpTools), JSON.stringify(snapshot.mcpInstallations)]
    );
    if (result.rowCount) await markCapabilityMappingsForAgentReview(workspaceId, agentId, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAgentDefinition(workspaceId, agentId);
}

export async function updateAgentReadiness(
  workspaceId: string,
  agentId: string,
  readiness: AgentDefinition['readiness']
): Promise<AgentDefinition | null> {
  const result = await db.query(
    `UPDATE agent_definitions
     SET readiness_status=$3,readiness_reasons=$4,
         updated_at=GREATEST(NOW(),updated_at + INTERVAL '1 millisecond')
     WHERE workspace_id=$1 AND id=$2
       AND (readiness_status IS DISTINCT FROM $3 OR readiness_reasons IS DISTINCT FROM $4::jsonb)
     RETURNING id`,
    [workspaceId, agentId, readiness.status, JSON.stringify(readiness.reasons)]
  );
  return result.rowCount ? getAgentDefinition(workspaceId, agentId) : null;
}

export function resetAgentRepositoryForTests(): void {}
