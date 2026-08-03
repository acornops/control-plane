import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../infra/db.js';

export interface TemplateInstallationRecord {
  workspaceId: string;
  templateId: string;
  state: 'pending' | 'complete';
  installedBy: string;
  recordIds: Record<string, string>;
  installedAt: string;
}

export interface TemplateRecordReference {
  templateId: string;
  recordKey: string;
}

type Row = QueryResultRow;

interface Queryable {
  query: PoolClient['query'];
}

export function mapTemplateInstallation(row: Row): TemplateInstallationRecord {
  return {
    workspaceId: row.workspace_id,
    templateId: row.template_id,
    state: row.state,
    installedBy: row.installed_by,
    recordIds: row.record_ids || {},
    installedAt: new Date(row.installed_at).toISOString()
  };
}

export async function listTemplateInstallations(workspaceId: string): Promise<TemplateInstallationRecord[]> {
  const result = await db.query<Row>(
    'SELECT * FROM automation_template_installations WHERE workspace_id=$1 ORDER BY installed_at,template_id',
    [workspaceId]
  );
  return result.rows.map(mapTemplateInstallation);
}

export function templateRecordReferencesById(
  installations: TemplateInstallationRecord[]
): Map<string, TemplateRecordReference> {
  const references = new Map<string, TemplateRecordReference>();
  for (const installation of installations) {
    if (installation.state !== 'complete') continue;
    for (const [recordKey, recordId] of Object.entries(installation.recordIds)) {
      references.set(recordId, { templateId: installation.templateId, recordKey });
    }
  }
  return references;
}

export async function reserveTemplateInstallation(input: {
  workspaceId: string;
  templateId: string;
  installedBy: string;
}, queryable: Queryable = db): Promise<TemplateInstallationRecord> {
  await queryable.query(
    `INSERT INTO automation_template_installations (
       workspace_id,template_id,state,installed_by,record_ids
     ) VALUES ($1,$2,'pending',$3,'{}'::jsonb)
     ON CONFLICT (workspace_id,template_id) DO NOTHING`,
    [input.workspaceId, input.templateId, input.installedBy]
  );
  const result = await queryable.query<Row>(
    `SELECT * FROM automation_template_installations
     WHERE workspace_id=$1 AND template_id=$2
     FOR UPDATE`,
    [input.workspaceId, input.templateId]
  );
  if (!result.rowCount) throw new Error('Template installation reservation disappeared');
  return mapTemplateInstallation(result.rows[0]);
}

export async function completeTemplateInstallation(
  workspaceId: string,
  templateId: string,
  recordIds: Record<string, string>,
  queryable: Queryable = db
): Promise<TemplateInstallationRecord> {
  const result = await queryable.query<Row>(
    `UPDATE automation_template_installations
     SET state='complete',record_ids=$3,installed_at=NOW()
     WHERE workspace_id=$1 AND template_id=$2 RETURNING *`,
    [workspaceId, templateId, recordIds]
  );
  if (!result.rowCount) throw new Error('Template installation reservation disappeared');
  return mapTemplateInstallation(result.rows[0]);
}

export async function updateTemplateInstallationRecordIds(
  workspaceId: string,
  templateId: string,
  recordIds: Record<string, string>,
  queryable: Queryable = db
): Promise<TemplateInstallationRecord> {
  const result = await queryable.query<Row>(
    `UPDATE automation_template_installations SET record_ids=$3,installed_at=NOW()
     WHERE workspace_id=$1 AND template_id=$2 RETURNING *`,
    [workspaceId, templateId, recordIds]
  );
  if (!result.rowCount) throw new Error('Template installation was not found');
  return mapTemplateInstallation(result.rows[0]);
}

export async function pruneTemplateInstallationRecordReference(
  workspaceId: string,
  recordId: string,
  queryable: Queryable = db
): Promise<void> {
  await queryable.query(
    `UPDATE automation_template_installations installation
     SET record_ids=COALESCE((
       SELECT jsonb_object_agg(entry.key, entry.value)
       FROM jsonb_each_text(installation.record_ids) entry
       WHERE entry.value <> $2
     ), '{}'::jsonb)
     WHERE installation.workspace_id=$1
       AND EXISTS (
         SELECT 1 FROM jsonb_each_text(installation.record_ids) entry
         WHERE entry.value=$2
       )`,
    [workspaceId, recordId]
  );
}
