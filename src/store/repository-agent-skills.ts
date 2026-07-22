import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import type { AgentSkillInstallationSnapshot } from '../types/agents.js';
import { withTransaction } from './repository-transaction.js';

type AgentSkillRow = QueryResultRow & {
  workspace_id: string; agent_id: string; id: string; name: string; description: string;
  source_type: 'manual' | 'git' | 'template'; source_url: string | null; source_ref: string | null;
  source_path: string | null; pinned_commit: string | null; content_digest: string; enabled: boolean;
  provenance: Record<string, unknown> | null;
  revision: number; created_by: string; created_at: Date | string; updated_at: Date | string;
};

export interface AgentSkillInput {
  workspaceId: string;
  agentId: string;
  name: string;
  description: string;
  enabled: boolean;
  source: AgentSkillInstallationSnapshot['source'];
  files: Array<{ path: string; content: string }>;
  actorUserId: string;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizedFiles(files: AgentSkillInput['files']) {
  return files.map((file) => ({ path: file.path, content: file.content, contentDigest: digest(file.content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function bundleDigest(files: ReturnType<typeof normalizedFiles>): string {
  return digest(JSON.stringify(files.map((file) => ({ path: file.path, contentDigest: file.contentDigest }))));
}

function sourceProvenance(source: AgentSkillInstallationSnapshot['source']): Record<string, unknown> | null {
  if (source.type !== 'git') return null;
  return {
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.apiBaseUrl ? { apiBaseUrl: source.apiBaseUrl } : {})
  };
}

async function filesFor(
  workspaceId: string,
  agentId: string,
  skillId: string,
  client: Pick<PoolClient, 'query'> | typeof db = db
) {
  const result = await client.query<{ path: string; content: string; content_digest: string }>(
    `SELECT path,content,content_digest FROM agent_skill_files
     WHERE workspace_id=$1 AND agent_id=$2 AND skill_id=$3 ORDER BY path`,
    [workspaceId, agentId, skillId]
  );
  return result.rows.map((row) => ({ path: row.path, content: row.content, contentDigest: row.content_digest }));
}

async function mapRow(row: AgentSkillRow, client: Pick<PoolClient, 'query'> | typeof db = db): Promise<AgentSkillInstallationSnapshot> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    revision: Number(row.revision),
    contentDigest: row.content_digest,
    source: {
      type: row.source_type,
      ...(row.provenance?.provider === 'github' || row.provenance?.provider === 'gitlab'
        ? { provider: row.provenance.provider } : {}),
      ...(row.source_url ? { url: row.source_url } : {}),
      ...(typeof row.provenance?.apiBaseUrl === 'string' ? { apiBaseUrl: row.provenance.apiBaseUrl } : {}),
      ...(row.source_ref ? { ref: row.source_ref } : {}),
      ...(row.source_path ? { path: row.source_path } : {}),
      ...(row.pinned_commit ? { pinnedCommit: row.pinned_commit } : {})
    },
    files: await filesFor(row.workspace_id, row.agent_id, row.id, client)
  };
}

export async function listAgentSkills(workspaceId: string, agentId: string): Promise<AgentSkillInstallationSnapshot[]> {
  const result = await db.query<AgentSkillRow>(
    `SELECT * FROM agent_skills WHERE workspace_id=$1 AND agent_id=$2 ORDER BY lower(name),id`,
    [workspaceId, agentId]
  );
  return Promise.all(result.rows.map((row) => mapRow(row)));
}

export async function getAgentSkill(workspaceId: string, agentId: string, skillId: string): Promise<AgentSkillInstallationSnapshot | null> {
  const result = await db.query<AgentSkillRow>(
    `SELECT * FROM agent_skills WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
    [workspaceId, agentId, skillId]
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
}

async function replaceFiles(client: PoolClient, input: AgentSkillInput, skillId: string, files: ReturnType<typeof normalizedFiles>): Promise<void> {
  await client.query(
    `DELETE FROM agent_skill_files WHERE workspace_id=$1 AND agent_id=$2 AND skill_id=$3`,
    [input.workspaceId, input.agentId, skillId]
  );
  for (const file of files) {
    await client.query(
      `INSERT INTO agent_skill_files (workspace_id,agent_id,skill_id,path,content,content_digest)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.workspaceId, input.agentId, skillId, file.path, file.content, file.contentDigest]
    );
  }
}

export async function createAgentSkill(input: AgentSkillInput): Promise<AgentSkillInstallationSnapshot> {
  return withTransaction(async (client) => {
    const id = randomUUID();
    const files = normalizedFiles(input.files);
    await client.query(
      `INSERT INTO agent_skills (
         workspace_id,agent_id,id,name,description,source_type,source_url,source_ref,source_path,pinned_commit,
         provenance,content_digest,enabled,revision,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14)`,
      [input.workspaceId, input.agentId, id, input.name, input.description, input.source.type,
       input.source.url || null, input.source.ref || null, input.source.path || null, input.source.pinnedCommit || null,
       sourceProvenance(input.source), bundleDigest(files), input.enabled, input.actorUserId]
    );
    await replaceFiles(client, input, id, files);
    const result = await client.query<AgentSkillRow>(
      `SELECT * FROM agent_skills WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
      [input.workspaceId, input.agentId, id]
    );
    return mapRow(result.rows[0], client);
  });
}

export async function updateAgentSkill(
  input: AgentSkillInput & { skillId: string; expectedRevision?: number }
): Promise<AgentSkillInstallationSnapshot | null> {
  return withTransaction(async (client) => {
    const files = normalizedFiles(input.files);
    const result = await client.query<AgentSkillRow>(
      `UPDATE agent_skills SET name=$4,description=$5,source_type=$6,source_url=$7,source_ref=$8,source_path=$9,
         pinned_commit=$10,provenance=$11,content_digest=$12,enabled=$13,revision=revision+1,updated_at=NOW()
       WHERE workspace_id=$1 AND agent_id=$2 AND id=$3
         AND ($14::int IS NULL OR revision=$14)
       RETURNING *`,
      [input.workspaceId, input.agentId, input.skillId, input.name, input.description, input.source.type,
       input.source.url || null, input.source.ref || null, input.source.path || null, input.source.pinnedCommit || null,
       sourceProvenance(input.source), bundleDigest(files), input.enabled, input.expectedRevision || null]
    );
    if (!result.rowCount) return null;
    await replaceFiles(client, input, input.skillId, files);
    return mapRow(result.rows[0], client);
  });
}

export async function setAgentSkillEnabled(
  workspaceId: string, agentId: string, skillId: string, enabled: boolean, expectedRevision?: number
): Promise<AgentSkillInstallationSnapshot | null> {
  const result = await db.query<AgentSkillRow>(
    `UPDATE agent_skills SET enabled=$4,revision=revision+1,updated_at=NOW()
     WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 AND ($5::int IS NULL OR revision=$5) RETURNING *`,
    [workspaceId, agentId, skillId, enabled, expectedRevision || null]
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
}

export async function deleteAgentSkill(workspaceId: string, agentId: string, skillId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM agent_skills WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
    [workspaceId, agentId, skillId]
  );
  return Boolean(result.rowCount);
}
