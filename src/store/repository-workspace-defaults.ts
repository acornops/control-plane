import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../infra/db.js';
import type { AdminAuditEventInput } from './repository-admin-audit.js';
import { insertAdminAuditEvent } from './repository-admin-audit.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import type {
  WorkspaceDefault,
  WorkspaceDefaultAvailability,
  WorkspaceDefaultKind,
  WorkspaceDefaultSkillFile,
  WorkspaceInitialDefault
} from '../types/workspace-defaults.js';

type Queryable = Pick<PoolClient, 'query'> | typeof db;

interface WorkspaceDefaultRow {
  id: string;
  kind: WorkspaceDefaultKind;
  name: string;
  description: string;
  available_in: WorkspaceDefaultAvailability[];
  source: WorkspaceDefault['source'] | string;
  content_digest: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkspaceInitialDefaultRow {
  workspace_id: string;
  id: string;
  kind: WorkspaceDefaultKind;
  name: string;
  description: string;
  available_in: WorkspaceDefaultAvailability[];
  source: WorkspaceDefault['source'] | string;
  content_digest: string | null;
  initialized_at: Date | string;
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeFiles(files: Array<{ path: string; content: string }> = []): WorkspaceDefaultSkillFile[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    contentDigest: digest(file.content),
    sizeBytes: Buffer.byteLength(file.content, 'utf8')
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function bundleDigest(files: WorkspaceDefaultSkillFile[]): string | null {
  return files.length
    ? digest(JSON.stringify(files.map((file) => ({ path: file.path, contentDigest: file.contentDigest }))))
    : null;
}

async function filesFor(
  table: 'workspace_default_skill_files' | 'workspace_initial_default_skill_files',
  defaultId: string,
  client: Queryable = db,
  workspaceId?: string
): Promise<WorkspaceDefaultSkillFile[]> {
  const result = workspaceId
    ? await client.query<{
      path: string; content: string; content_digest: string; size_bytes: number;
    }>(
      `SELECT path, content, content_digest, size_bytes
       FROM ${table}
       WHERE workspace_id = $1 AND default_id = $2
       ORDER BY path`,
      [workspaceId, defaultId]
    )
    : await client.query<{
      path: string; content: string; content_digest: string; size_bytes: number;
    }>(
      `SELECT path, content, content_digest, size_bytes
       FROM ${table}
       WHERE default_id = $1
       ORDER BY path`,
      [defaultId]
    );
  return result.rows.map((row) => ({
    path: row.path,
    content: row.content,
    contentDigest: row.content_digest,
    sizeBytes: Number(row.size_bytes)
  }));
}

async function mapDefaultRow(
  row: WorkspaceDefaultRow,
  includeFiles = false,
  client: Queryable = db
): Promise<WorkspaceDefault> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    availableIn: row.available_in,
    source: json(row.source),
    ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
    ...(includeFiles && row.kind === 'skill'
      ? { files: await filesFor('workspace_default_skill_files', row.id, client) }
      : {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!
  };
}

async function mapInitialRow(
  row: WorkspaceInitialDefaultRow,
  includeFiles = false,
  client: Queryable = db
): Promise<WorkspaceInitialDefault> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    availableIn: row.available_in,
    source: json(row.source),
    ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
    ...(includeFiles && row.kind === 'skill'
      ? {
        files: await filesFor(
          'workspace_initial_default_skill_files',
          row.id,
          client,
          row.workspace_id
        )
      }
      : {}),
    initializedAt: toIso(row.initialized_at)!
  };
}

export async function listWorkspaceDefaults(filters: {
  kind?: WorkspaceDefaultKind;
  availableIn?: WorkspaceDefaultAvailability;
  q?: string;
  includeFiles?: boolean;
} = {}): Promise<WorkspaceDefault[]> {
  const params: string[] = [];
  const clauses: string[] = [];
  if (filters.kind) {
    params.push(filters.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (filters.availableIn) {
    params.push(filters.availableIn);
    clauses.push(`available_in @> ARRAY[$${params.length}]::TEXT[]`);
  }
  if (filters.q) {
    params.push(`%${filters.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    clauses.push(`(name ILIKE $${params.length} ESCAPE '\\' OR source::text ILIKE $${params.length} ESCAPE '\\')`);
  }
  const result = await db.query<WorkspaceDefaultRow>(
    `SELECT * FROM workspace_defaults
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY kind, lower(name), id`,
    params
  );
  return Promise.all(result.rows.map((row) => mapDefaultRow(row, filters.includeFiles === true)));
}

export async function getWorkspaceDefault(id: string, includeFiles = true): Promise<WorkspaceDefault | null> {
  const result = await db.query<WorkspaceDefaultRow>('SELECT * FROM workspace_defaults WHERE id = $1', [id]);
  return result.rowCount ? mapDefaultRow(result.rows[0], includeFiles) : null;
}

export async function initializeWorkspaceDefaults(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `WITH copied_defaults AS (
       INSERT INTO workspace_initial_defaults (
         workspace_id, id, kind, name, description, available_in, source,
         content_digest, initialized_at
       )
       SELECT $1, id, kind, name, description, available_in, source,
         content_digest, NOW()
       FROM workspace_defaults
       RETURNING workspace_id, id
     )
     INSERT INTO workspace_initial_default_skill_files (
       workspace_id, default_id, path, content, content_digest, size_bytes
     )
     SELECT $1, files.default_id, files.path, files.content, files.content_digest, files.size_bytes
     FROM workspace_default_skill_files files
     JOIN copied_defaults copied ON copied.id = files.default_id`,
    [workspaceId]
  );
}

export async function listWorkspaceInitialDefaults(input: {
  workspaceId: string;
  kind: WorkspaceDefaultKind;
  includeFiles?: boolean;
}): Promise<WorkspaceInitialDefault[]> {
  const result = await db.query<WorkspaceInitialDefaultRow>(
    `SELECT *
     FROM workspace_initial_defaults
     WHERE workspace_id = $1 AND kind = $2
     ORDER BY lower(name), id`,
    [input.workspaceId, input.kind]
  );
  return Promise.all(result.rows.map((row) => mapInitialRow(row, input.includeFiles === true)));
}

export async function getWorkspaceInitialDefault(
  workspaceId: string,
  id: string,
  includeFiles = true
): Promise<WorkspaceInitialDefault | null> {
  const result = await db.query<WorkspaceInitialDefaultRow>(
    'SELECT * FROM workspace_initial_defaults WHERE workspace_id = $1 AND id = $2',
    [workspaceId, id]
  );
  return result.rowCount ? mapInitialRow(result.rows[0], includeFiles) : null;
}

export async function createWorkspaceDefault(input: {
  kind: WorkspaceDefaultKind;
  name: string;
  description?: string;
  availableIn: WorkspaceDefaultAvailability[];
  source: WorkspaceDefault['source'];
  files?: Array<{ path: string; content: string }>;
  actorId: string;
  auditEvent: AdminAuditEventInput;
}): Promise<WorkspaceDefault> {
  return withTransaction(async (client) => {
    const id = randomUUID();
    const files = normalizeFiles(input.files);
    const result = await client.query<WorkspaceDefaultRow>(
      `INSERT INTO workspace_defaults (
         id, kind, name, description, available_in, source,
         content_digest, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8)
       RETURNING *`,
      [id, input.kind, input.name, input.description || '', input.availableIn,
       JSON.stringify(input.source), bundleDigest(files), input.actorId]
    );
    for (const file of files) {
      await client.query(
        `INSERT INTO workspace_default_skill_files
         (default_id, path, content, content_digest, size_bytes)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, file.path, file.content, file.contentDigest, file.sizeBytes]
      );
    }
    await insertAdminAuditEvent(input.auditEvent, client);
    return mapDefaultRow(result.rows[0], false, client);
  });
}

export async function updateWorkspaceDefaultAvailability(input: {
  id: string;
  availableIn: WorkspaceDefaultAvailability[];
  actorId: string;
  auditEvent: AdminAuditEventInput;
}): Promise<WorkspaceDefault | null> {
  return withTransaction(async (client) => {
    const result = await client.query<WorkspaceDefaultRow>(
      `UPDATE workspace_defaults
       SET available_in=$2, updated_by=$3, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [input.id, input.availableIn, input.actorId]
    );
    if (!result.rowCount) return null;
    await insertAdminAuditEvent(input.auditEvent, client);
    return mapDefaultRow(result.rows[0], false, client);
  });
}

export async function deleteWorkspaceDefault(input: {
  id: string;
  auditEvent: AdminAuditEventInput;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query('DELETE FROM workspace_defaults WHERE id=$1', [input.id]);
    if (!result.rowCount) return false;
    await insertAdminAuditEvent(input.auditEvent, client);
    return true;
  });
}
