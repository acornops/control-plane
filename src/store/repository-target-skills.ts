import { randomUUID } from 'node:crypto';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { TargetSkillDetail, TargetSkillFile, TargetSkillSource, TargetSkillSummary } from '../types/domain.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface TargetSkillRow {
  id: string;
  workspace_id: string;
  target_id: string;
  target_type: 'kubernetes' | 'virtual_machine';
  name: string;
  description: string;
  source_type: 'manual' | 'git_import';
  source_provider: 'github' | 'gitlab' | null;
  enabled: boolean;
  validation_status: 'valid' | 'invalid';
  validation_errors: string[] | null;
  file_count: number;
  total_bytes: number;
  source_repo_url: string | null;
  source_api_base_url: string | null;
  source_ref: string | null;
  source_subpath: string | null;
  source_commit_sha: string | null;
  sync_status: 'not_applicable' | 'current' | 'modified';
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TargetSkillFileRow {
  skill_id: string;
  path: string;
  content: string;
  size_bytes: number;
}

interface Queryable {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
}

export interface UpsertTargetSkillInput {
  workspaceId: string;
  targetId: string;
  name: string;
  description: string;
  enabled: boolean;
  validationStatus: 'valid' | 'invalid';
  validationErrors: string[];
  bundleStats: {
    fileCount: number;
    totalBytes: number;
  };
  source: TargetSkillSource;
  files: TargetSkillFile[];
  actorUserId: string;
}

export interface UpdateTargetSkillInput extends UpsertTargetSkillInput {
  skillId: string;
}

export async function listTargetSkills(targetId: string): Promise<TargetSkillSummary[]> {
  const result = await db.query<TargetSkillRow>(
    `SELECT s.id,
            s.workspace_id,
            s.target_id,
            t.target_type,
            s.name,
            s.description,
            s.source_type,
            s.source_provider,
            s.enabled,
            s.validation_status,
            s.validation_errors,
            s.file_count,
            s.total_bytes,
            s.source_repo_url,
            s.source_api_base_url,
            s.source_ref,
            s.source_subpath,
            s.source_commit_sha,
            s.sync_status,
            s.created_by,
            s.updated_by,
            s.created_at,
            s.updated_at
     FROM target_skills s
     INNER JOIN targets t ON t.id = s.target_id
     WHERE s.target_id = $1
     ORDER BY s.updated_at DESC, s.id DESC`,
    [targetId]
  );
  return result.rows.map(mapTargetSkillSummary);
}

export async function getTargetSkill(targetId: string, skillId: string): Promise<TargetSkillDetail | null> {
  const row = await getTargetSkillRow(targetId, skillId);
  if (!row) {
    return null;
  }
  return {
    ...mapTargetSkillSummary(row),
    files: await listTargetSkillFiles(skillId)
  };
}

export async function createTargetSkill(input: UpsertTargetSkillInput): Promise<TargetSkillDetail> {
  return withTransaction(async (client) => {
    const skillId = randomUUID();
    await insertOrUpdateTargetSkill(client, {
      ...input,
      skillId
    });
    return getTargetSkillInTransaction(client, input.targetId, skillId) as Promise<TargetSkillDetail>;
  });
}

export async function updateTargetSkill(input: UpdateTargetSkillInput): Promise<TargetSkillDetail | null> {
  return withTransaction(async (client) => {
    const existing = await getTargetSkillRowInTransaction(client, input.targetId, input.skillId);
    if (!existing) {
      return null;
    }
    await insertOrUpdateTargetSkill(client, input);
    return getTargetSkillInTransaction(client, input.targetId, input.skillId);
  });
}

export async function updateTargetSkillEnabled(
  targetId: string,
  skillId: string,
  enabled: boolean,
  actorUserId: string
): Promise<TargetSkillDetail | null> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE target_skills
       SET enabled = $3,
           updated_by = $4,
           updated_at = NOW()
       WHERE target_id = $1
         AND id = $2`,
      [targetId, skillId, enabled, actorUserId]
    );
    if (!result.rowCount) {
      return null;
    }
    return getTargetSkillInTransaction(client, targetId, skillId);
  });
}

export async function deleteTargetSkill(targetId: string, skillId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM target_skills
     WHERE target_id = $1
       AND id = $2`,
    [targetId, skillId]
  );
  return Boolean(result.rowCount);
}

export async function countEnabledTargetSkills(targetId: string, excludeSkillId?: string): Promise<number> {
  const params: Array<string> = [targetId];
  let excludeClause = '';
  if (excludeSkillId) {
    params.push(excludeSkillId);
    excludeClause = ` AND id <> $${params.length}`;
  }
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM target_skills
     WHERE target_id = $1
       AND enabled = true${excludeClause}`,
    params
  );
  return Number(result.rows[0]?.count || '0');
}

export async function listEnabledValidTargetSkills(targetId: string): Promise<TargetSkillDetail[]> {
  return listEnabledValidTargetSkillsInTransaction(db, targetId);
}

export async function listEnabledValidTargetSkillSummaries(targetId: string): Promise<TargetSkillSummary[]> {
  const result = await db.query<TargetSkillRow>(
    `SELECT s.id,
            s.workspace_id,
            s.target_id,
            t.target_type,
            s.name,
            s.description,
            s.source_type,
            s.source_provider,
            s.enabled,
            s.validation_status,
            s.validation_errors,
            s.file_count,
            s.total_bytes,
            s.source_repo_url,
            s.source_api_base_url,
            s.source_ref,
            s.source_subpath,
            s.source_commit_sha,
            s.sync_status,
            s.created_by,
            s.updated_by,
            s.created_at,
            s.updated_at
     FROM target_skills s
     INNER JOIN targets t ON t.id = s.target_id
     WHERE s.target_id = $1
       AND s.enabled = true
       AND s.validation_status = 'valid'
     ORDER BY lower(s.name) ASC, s.id ASC`,
    [targetId]
  );
  return result.rows.map(mapTargetSkillSummary);
}

export async function listEnabledValidTargetSkillsInTransaction(
  queryable: Queryable,
  targetId: string
): Promise<TargetSkillDetail[]> {
  const result = await queryable.query<TargetSkillRow>(
    `SELECT s.id,
            s.workspace_id,
            s.target_id,
            t.target_type,
            s.name,
            s.description,
            s.source_type,
            s.source_provider,
            s.enabled,
            s.validation_status,
            s.validation_errors,
            s.file_count,
            s.total_bytes,
            s.source_repo_url,
            s.source_api_base_url,
            s.source_ref,
            s.source_subpath,
            s.source_commit_sha,
            s.sync_status,
            s.created_by,
            s.updated_by,
            s.created_at,
            s.updated_at
     FROM target_skills s
     INNER JOIN targets t ON t.id = s.target_id
     WHERE s.target_id = $1
       AND s.enabled = true
       AND s.validation_status = 'valid'
     ORDER BY lower(s.name) ASC, s.id ASC`,
    [targetId]
  );
  if (result.rows.length === 0) {
    return [];
  }
  const fileRows = await queryable.query<TargetSkillFileRow>(
    `SELECT skill_id, path, content, size_bytes
     FROM target_skill_files
     WHERE skill_id = ANY($1::text[])
     ORDER BY path ASC`,
    [result.rows.map((row) => row.id)]
  );
  const filesBySkillId = new Map<string, TargetSkillFile[]>();
  for (const row of fileRows.rows) {
    const current = filesBySkillId.get(row.skill_id) || [];
    current.push(mapTargetSkillFile(row));
    filesBySkillId.set(row.skill_id, current);
  }
  return result.rows.map((row) => ({
    ...mapTargetSkillSummary(row),
    files: (filesBySkillId.get(row.id) || []).sort((left, right) => left.path.localeCompare(right.path))
  }));
}

async function insertOrUpdateTargetSkill(
  client: PoolClient,
  input: UpsertTargetSkillInput | UpdateTargetSkillInput
): Promise<void> {
  const skillId = 'skillId' in input ? input.skillId : randomUUID();
  await client.query(
    `INSERT INTO target_skills (
       id,
       workspace_id,
       target_id,
       name,
       description,
       source_type,
       source_provider,
       enabled,
       validation_status,
       validation_errors,
       file_count,
       total_bytes,
       source_repo_url,
       source_api_base_url,
       source_ref,
       source_subpath,
       source_commit_sha,
       sync_status,
       created_by,
       updated_by,
       created_at,
       updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW(), NOW()
     )
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         description = EXCLUDED.description,
         source_type = EXCLUDED.source_type,
         source_provider = EXCLUDED.source_provider,
         enabled = EXCLUDED.enabled,
         validation_status = EXCLUDED.validation_status,
         validation_errors = EXCLUDED.validation_errors,
         file_count = EXCLUDED.file_count,
         total_bytes = EXCLUDED.total_bytes,
         source_repo_url = EXCLUDED.source_repo_url,
         source_api_base_url = EXCLUDED.source_api_base_url,
         source_ref = EXCLUDED.source_ref,
         source_subpath = EXCLUDED.source_subpath,
         source_commit_sha = EXCLUDED.source_commit_sha,
         sync_status = EXCLUDED.sync_status,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
    [
      skillId,
      input.workspaceId,
      input.targetId,
      input.name,
      input.description,
      input.source.type,
      input.source.provider || null,
      input.enabled,
      input.validationStatus,
      JSON.stringify(input.validationErrors),
      input.bundleStats.fileCount,
      input.bundleStats.totalBytes,
      input.source.repoUrl || null,
      input.source.apiBaseUrl || null,
      input.source.ref || null,
      input.source.subpath || null,
      input.source.commitSha || null,
      input.source.syncStatus,
      input.actorUserId,
      input.actorUserId
    ]
  );
  await client.query('DELETE FROM target_skill_files WHERE skill_id = $1', [skillId]);
  for (const file of input.files) {
    await client.query(
      `INSERT INTO target_skill_files (skill_id, path, content, size_bytes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [skillId, file.path, file.content, file.sizeBytes]
    );
  }
}

async function getTargetSkillInTransaction(client: PoolClient, targetId: string, skillId: string): Promise<TargetSkillDetail | null> {
  const row = await getTargetSkillRowInTransaction(client, targetId, skillId);
  if (!row) {
    return null;
  }
  const filesResult = await client.query<TargetSkillFileRow>(
    `SELECT skill_id, path, content, size_bytes
     FROM target_skill_files
     WHERE skill_id = $1
     ORDER BY path ASC`,
    [skillId]
  );
  return {
    ...mapTargetSkillSummary(row),
    files: filesResult.rows.map(mapTargetSkillFile)
  };
}

async function getTargetSkillRow(targetId: string, skillId: string): Promise<TargetSkillRow | null> {
  const result = await db.query<TargetSkillRow>(
    `SELECT s.id,
            s.workspace_id,
            s.target_id,
            t.target_type,
            s.name,
            s.description,
            s.source_type,
            s.source_provider,
            s.enabled,
            s.validation_status,
            s.validation_errors,
            s.file_count,
            s.total_bytes,
            s.source_repo_url,
            s.source_api_base_url,
            s.source_ref,
            s.source_subpath,
            s.source_commit_sha,
            s.sync_status,
            s.created_by,
            s.updated_by,
            s.created_at,
            s.updated_at
     FROM target_skills s
     INNER JOIN targets t ON t.id = s.target_id
     WHERE s.target_id = $1
       AND s.id = $2`,
    [targetId, skillId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function getTargetSkillRowInTransaction(client: PoolClient, targetId: string, skillId: string): Promise<TargetSkillRow | null> {
  const result = await client.query<TargetSkillRow>(
    `SELECT s.id,
            s.workspace_id,
            s.target_id,
            t.target_type,
            s.name,
            s.description,
            s.source_type,
            s.source_provider,
            s.enabled,
            s.validation_status,
            s.validation_errors,
            s.file_count,
            s.total_bytes,
            s.source_repo_url,
            s.source_api_base_url,
            s.source_ref,
            s.source_subpath,
            s.source_commit_sha,
            s.sync_status,
            s.created_by,
            s.updated_by,
            s.created_at,
            s.updated_at
     FROM target_skills s
     INNER JOIN targets t ON t.id = s.target_id
     WHERE s.target_id = $1
       AND s.id = $2
     FOR UPDATE`,
    [targetId, skillId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function listTargetSkillFiles(skillId: string): Promise<TargetSkillFile[]> {
  const result = await db.query<TargetSkillFileRow>(
    `SELECT skill_id, path, content, size_bytes
     FROM target_skill_files
     WHERE skill_id = $1
     ORDER BY path ASC`,
    [skillId]
  );
  return result.rows.map(mapTargetSkillFile);
}

function mapTargetSkillSummary(row: TargetSkillRow): TargetSkillSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    targetType: row.target_type,
    ...(row.target_type === 'kubernetes' ? { clusterId: row.target_id } : {}),
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    validationStatus: row.validation_status,
    validationErrors: Array.isArray(row.validation_errors) ? row.validation_errors : [],
    bundleStats: {
      fileCount: Number(row.file_count),
      totalBytes: Number(row.total_bytes)
    },
    source: {
      type: row.source_type,
      provider: row.source_provider || undefined,
      repoUrl: row.source_repo_url || undefined,
      apiBaseUrl: row.source_api_base_url || undefined,
      ref: row.source_ref || undefined,
      subpath: row.source_subpath || undefined,
      commitSha: row.source_commit_sha || undefined,
      syncStatus: row.sync_status
    },
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

function mapTargetSkillFile(row: TargetSkillFileRow): TargetSkillFile {
  return {
    path: row.path,
    content: row.content,
    sizeBytes: Number(row.size_bytes)
  };
}
