import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { isSupportedRole } from '../auth/authorization.js';
import type { Role } from '../types/domain.js';

export interface ServiceIdentity {
  workspaceId: string;
  id: string;
  name: string;
  status: 'active' | 'disabled';
  role: Role;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const map = (row: Record<string, unknown>): ServiceIdentity => ({
  workspaceId: String(row.workspace_id), id: String(row.id), name: String(row.name),
  status: row.status === 'disabled' ? 'disabled' : 'active', role: row.role as Role,
  createdBy: String(row.created_by), createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString()
});

export async function listServiceIdentities(workspaceId: string): Promise<ServiceIdentity[]> {
  const result = await db.query('SELECT * FROM service_identities WHERE workspace_id=$1 ORDER BY name,id', [workspaceId]);
  return result.rows.map(map);
}

export async function getServiceIdentity(workspaceId: string, id: string): Promise<ServiceIdentity | null> {
  const result = await db.query('SELECT * FROM service_identities WHERE workspace_id=$1 AND id=$2', [workspaceId, id]);
  return result.rowCount ? map(result.rows[0]) : null;
}

export async function createServiceIdentity(input: { workspaceId: string; name: string; role: Role; createdBy: string }): Promise<ServiceIdentity> {
  if (!isSupportedRole(input.role) || input.role === 'owner') throw new Error('SERVICE_IDENTITY_ROLE_INVALID');
  const id = `svc-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'automation'}-${randomUUID().slice(0, 8)}`;
  const result = await db.query(
    `INSERT INTO service_identities (workspace_id,id,name,status,role,created_by)
     VALUES ($1,$2,$3,'active',$4,$5) RETURNING *`,
    [input.workspaceId, id, input.name.trim(), input.role, input.createdBy]
  );
  return map(result.rows[0]);
}

export async function updateServiceIdentity(input: { workspaceId: string; id: string; name?: string; role?: Role; status?: 'active' | 'disabled' }): Promise<ServiceIdentity | null> {
  if (input.role && (!isSupportedRole(input.role) || input.role === 'owner')) throw new Error('SERVICE_IDENTITY_ROLE_INVALID');
  const result = await db.query(
    `UPDATE service_identities SET
       name=COALESCE($3,name), role=COALESCE($4,role), status=COALESCE($5,status), updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [input.workspaceId, input.id, input.name?.trim() || null, input.role || null, input.status || null]
  );
  return result.rowCount ? map(result.rows[0]) : null;
}
