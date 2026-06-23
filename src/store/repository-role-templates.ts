import { PoolClient } from 'pg';
import { groupWorkspaceCapabilities, WorkspaceCapability } from '../auth/authorization.js';
import { RoleTemplate, RoleTemplateKind } from '../types/domain.js';
import { db } from '../infra/db.js';
import { toIso } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface RoleTemplateRow {
  key: string;
  display_name: string;
  description: string;
  kind: RoleTemplateKind;
  capabilities: WorkspaceCapability[];
  protected: boolean;
  sort_order: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRoleTemplate(row: RoleTemplateRow): RoleTemplate {
  const capabilities = Array.isArray(row.capabilities) ? row.capabilities : [];
  return {
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    kind: row.kind,
    capabilities,
    capabilityGroups: groupWorkspaceCapabilities(capabilities),
    protected: row.protected,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

async function findUnsupportedRoleKeys(client: PoolClient, roleKeys: string[]): Promise<string[]> {
  const result = await client.query<{ role: string }>(
    `SELECT role
     FROM workspace_memberships
     WHERE NOT (role = ANY($1::text[]))
     UNION
     SELECT role
     FROM workspace_invitations
     WHERE NOT (role = ANY($1::text[]))
     ORDER BY role ASC`,
    [roleKeys]
  );
  return result.rows.map((row) => row.role);
}

export async function syncRoleTemplates(templates: RoleTemplate[]): Promise<RoleTemplate[]> {
  if (!templates.some((template) => template.key === 'owner')) {
    throw new Error('Role template sync requires owner');
  }
  const roleKeys = templates.map((template) => template.key);
  return withTransaction(async (client) => {
    const unsupportedRoleKeys = await findUnsupportedRoleKeys(client, roleKeys);
    if (unsupportedRoleKeys.length > 0) {
      throw new Error(`Existing workspace memberships or invitations use unsupported roles: ${unsupportedRoleKeys.join(', ')}`);
    }

    await client.query('DELETE FROM role_templates WHERE NOT (key = ANY($1::text[]))', [roleKeys]);
    for (const template of templates) {
      await client.query(
        `INSERT INTO role_templates (key, display_name, description, kind, capabilities, protected, sort_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW(), NOW())
         ON CONFLICT (key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             description = EXCLUDED.description,
             kind = EXCLUDED.kind,
             capabilities = EXCLUDED.capabilities,
             protected = EXCLUDED.protected,
             sort_order = EXCLUDED.sort_order,
             updated_at = NOW()`,
        [
          template.key,
          template.displayName,
          template.description,
          template.kind,
          JSON.stringify(template.capabilities),
          template.protected,
          template.sortOrder
        ]
      );
    }
    return listRoleTemplatesForClient(client);
  });
}

async function listRoleTemplatesForClient(client: PoolClient): Promise<RoleTemplate[]> {
  const result = await client.query<RoleTemplateRow>(
    `SELECT key, display_name, description, kind, capabilities, protected, sort_order, created_at, updated_at
     FROM role_templates
     ORDER BY sort_order ASC, display_name ASC`
  );
  return result.rows.map(mapRoleTemplate);
}

export async function listRoleTemplates(): Promise<RoleTemplate[]> {
  const result = await db.query<RoleTemplateRow>(
    `SELECT key, display_name, description, kind, capabilities, protected, sort_order, created_at, updated_at
     FROM role_templates
     ORDER BY sort_order ASC, display_name ASC`
  );
  return result.rows.map(mapRoleTemplate);
}

export async function getRoleTemplate(key: string): Promise<RoleTemplate | null> {
  const result = await db.query<RoleTemplateRow>(
    `SELECT key, display_name, description, kind, capabilities, protected, sort_order, created_at, updated_at
     FROM role_templates
     WHERE key = $1
     LIMIT 1`,
    [key]
  );
  return result.rowCount ? mapRoleTemplate(result.rows[0]) : null;
}
