import { createHash } from 'node:crypto';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';
import { TargetSkillDetail, TargetSkillFile, TargetSkillSource, TargetType } from '../types/domain.js';
import { withTransaction } from './repository-transaction.js';
import { listEnabledValidTargetSkillsInTransaction } from './repository-target-skills.js';

interface Queryable {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
}

interface RunSkillSnapshotRow {
  run_id: string;
  skill_ref: string;
  skill_id: string;
  content_hash: string;
  name: string;
  description: string;
  source: TargetSkillSource;
  file_count: number;
  total_bytes: number;
  created_at: Date | string;
}

interface SkillSnapshotBlobRow {
  files: Array<{ path: string; content: string; sizeBytes?: number; size_bytes?: number }>;
  file_count: number;
  total_bytes: number;
}

interface RunSkillSnapshotJoinRow extends RunSkillSnapshotRow {
  files: SkillSnapshotBlobRow['files'];
  blob_file_count: number;
  blob_total_bytes: number;
}

export interface RunSkillCatalogEntry {
  ref: string;
  skillId: string;
  name: string;
  description: string;
  fileCount: number;
  totalBytes: number;
}

export interface RunSkillSnapshot extends RunSkillCatalogEntry {
  contentHash: string;
  source: TargetSkillSource;
  files: TargetSkillFile[];
}

function normalizeSnapshotFiles(files: TargetSkillFile[]): TargetSkillFile[] {
  return files
    .map((file) => ({
      path: file.path,
      content: file.content,
      sizeBytes: file.sizeBytes ?? Buffer.byteLength(file.content, 'utf8')
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalFilesJson(files: TargetSkillFile[]): string {
  return JSON.stringify(normalizeSnapshotFiles(files).map((file) => ({
    path: file.path,
    content: file.content,
    sizeBytes: file.sizeBytes
  })));
}

function contentHashForFiles(files: TargetSkillFile[]): string {
  return `sha256:${createHash('sha256').update(canonicalFilesJson(files)).digest('hex')}`;
}

function compareSkillSnapshotOrder(left: TargetSkillDetail, right: TargetSkillDetail): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return left.id.localeCompare(right.id);
}

function skillSourceJson(source: TargetSkillSource): Record<string, unknown> {
  return {
    type: source.type,
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.repoUrl ? { repoUrl: source.repoUrl } : {}),
    ...(source.apiBaseUrl ? { apiBaseUrl: source.apiBaseUrl } : {}),
    ...(source.ref ? { ref: source.ref } : {}),
    ...(source.subpath ? { subpath: source.subpath } : {}),
    ...(source.commitSha ? { commitSha: source.commitSha } : {}),
    syncStatus: source.syncStatus
  };
}

function mapCatalogRow(row: RunSkillSnapshotRow): RunSkillCatalogEntry {
  return {
    ref: row.skill_ref,
    skillId: row.skill_id,
    name: row.name,
    description: row.description,
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes)
  };
}

function mapSnapshotRow(row: RunSkillSnapshotRow, blob: SkillSnapshotBlobRow): RunSkillSnapshot {
  const files = (blob.files || []).map((file) => ({
    path: file.path,
    content: file.content,
    sizeBytes: Number(file.sizeBytes ?? file.size_bytes ?? Buffer.byteLength(file.content || '', 'utf8'))
  }));
  return {
    ...mapCatalogRow(row),
    contentHash: row.content_hash,
    source: row.source,
    files
  };
}

async function listCatalogRows(runId: string, queryable: Queryable = db): Promise<RunSkillCatalogEntry[]> {
  const result = await queryable.query(
    `SELECT *
     FROM run_skill_snapshots
     WHERE run_id = $1
     ORDER BY substring(skill_ref FROM 7)::int ASC`,
    [runId]
  );
  return result.rows.map((row) => mapCatalogRow(row as RunSkillSnapshotRow));
}

async function insertSnapshotRows(
  client: PoolClient,
  params: {
    runId: string;
    workspaceId: string;
    targetId: string;
    targetType: TargetType;
    skills: TargetSkillDetail[];
  }
): Promise<void> {
  const sortedSkills = params.skills
    .slice()
    .sort(compareSkillSnapshotOrder);
  let totalBytes = 0;

  for (const [index, skill] of sortedSkills.entries()) {
    const files = normalizeSnapshotFiles(skill.files);
    const contentHash = contentHashForFiles(files);
    const fileCount = files.length;
    const totalFileBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    totalBytes += totalFileBytes;

    await client.query(
      `INSERT INTO skill_snapshot_blobs (content_hash, files, file_count, total_bytes, last_referenced_at)
       VALUES ($1, $2::jsonb, $3, $4, NOW())
       ON CONFLICT (content_hash) DO UPDATE
         SET last_referenced_at = NOW()`,
      [contentHash, JSON.stringify(files), fileCount, totalFileBytes]
    );

    await client.query(
      `INSERT INTO run_skill_snapshots (
         run_id, skill_ref, skill_id, content_hash, name, description, source, file_count, total_bytes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (run_id, skill_ref) DO NOTHING`,
      [
        params.runId,
        `skill_${index + 1}`,
        skill.id,
        contentHash,
        skill.name,
        skill.description,
        JSON.stringify(skillSourceJson(skill.source)),
        fileCount,
        totalFileBytes
      ]
    );
  }

  await client.query(
    `INSERT INTO run_skill_catalog_snapshots (run_id, workspace_id, target_id, target_type, skill_count, total_bytes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id) DO NOTHING`,
    [params.runId, params.workspaceId, params.targetId, params.targetType, sortedSkills.length, totalBytes]
  );
}

export async function createRunSkillSnapshot(params: {
  runId: string;
  workspaceId: string;
  targetId: string;
  targetType: TargetType;
}): Promise<RunSkillCatalogEntry[]> {
  return withTransaction(async (client) => {
    const runResult = await client.query<{
      id: string;
      workspace_id: string;
      target_id: string;
      target_type: TargetType;
    }>(
      `SELECT r.id, r.workspace_id, r.target_id, t.target_type
       FROM runs r
       JOIN targets t ON t.id = r.target_id
       WHERE r.id = $1
       FOR UPDATE`,
      [params.runId]
    );
    if (!runResult.rowCount) {
      throw new Error(`Cannot create skill snapshot for missing run ${params.runId}`);
    }
    const run = runResult.rows[0];
    if (
      run.workspace_id !== params.workspaceId ||
      run.target_id !== params.targetId ||
      run.target_type !== params.targetType
    ) {
      throw new Error(`Cannot create skill snapshot for run ${params.runId} with mismatched target scope`);
    }
    return createRunSkillSnapshotInTransaction(client, params);
  });
}

export async function createRunSkillSnapshotInTransaction(
  client: PoolClient,
  params: {
    runId: string;
    workspaceId: string;
    targetId: string;
    targetType: TargetType;
  }
): Promise<RunSkillCatalogEntry[]> {
  const existing = await client.query('SELECT run_id FROM run_skill_catalog_snapshots WHERE run_id = $1', [params.runId]);
  if (!existing.rowCount) {
    const skills = await listEnabledValidTargetSkillsInTransaction(client, params.targetId);
    await insertSnapshotRows(client, {
      ...params,
      skills
    });
  }
  return listCatalogRows(params.runId, client);
}

export async function getRunSkillCatalog(runId: string): Promise<RunSkillCatalogEntry[]> {
  return listCatalogRows(runId);
}

export async function getRunSkillSnapshot(runId: string, skillRef: string): Promise<RunSkillSnapshot | null> {
  const result = await db.query(
    `SELECT s.*, b.files, b.file_count AS blob_file_count, b.total_bytes AS blob_total_bytes
     FROM run_skill_snapshots s
     JOIN skill_snapshot_blobs b ON b.content_hash = s.content_hash
     WHERE s.run_id = $1
       AND s.skill_ref = $2`,
    [runId, skillRef]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0] as RunSkillSnapshotJoinRow;
  await db.query(
    `UPDATE skill_snapshot_blobs
     SET last_referenced_at = NOW()
     WHERE content_hash = $1`,
    [row.content_hash]
  );
  return mapSnapshotRow(row, {
    files: row.files,
    file_count: Number(row.blob_file_count),
    total_bytes: Number(row.blob_total_bytes)
  });
}

export async function purgeOrphanedSkillSnapshotBlobs(retentionDays: number, limit = 1000): Promise<number> {
  const safeRetentionDays = Math.max(1, Math.floor(Number.isFinite(retentionDays) ? retentionDays : 1));
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number.isFinite(limit) ? limit : 1000)));
  const result = await db.query(
    `WITH candidate AS (
       SELECT b.content_hash
       FROM skill_snapshot_blobs b
       WHERE b.last_referenced_at < NOW() - ($1::int * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1
           FROM run_skill_snapshots s
           WHERE s.content_hash = b.content_hash
         )
       ORDER BY b.created_at ASC, b.content_hash ASC
       LIMIT $2
     )
     DELETE FROM skill_snapshot_blobs b
     USING candidate c
     WHERE b.content_hash = c.content_hash`,
    [safeRetentionDays, safeLimit]
  );
  return result.rowCount ?? 0;
}
