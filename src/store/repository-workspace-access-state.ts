import { db } from '../infra/db.js';

export interface WorkspaceAccessState {
  id: string;
  name: string;
  accessState: 'active' | 'suspended';
  publicReason?: string;
  suspendedAt?: string;
}
interface AccessRow { id: string; name: string; lifecycle_status: string; public_reason: string | null; suspended_at: Date | null }
const projection = `SELECT w.id,w.name,w.lifecycle_status,w.suspended_at,
  CASE WHEN admin_hold.workspace_id IS NOT NULL THEN COALESCE(admin_hold.public_reason,'Contact your workspace administrator for assistance.')
    ELSE external_hold.public_reason END AS public_reason
  FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id
  LEFT JOIN workspace_suspension_holds admin_hold ON admin_hold.workspace_id=w.id AND admin_hold.source='admin'
  LEFT JOIN workspace_suspension_holds external_hold ON external_hold.workspace_id=w.id AND external_hold.source='external'`;

function accessState(row: AccessRow): WorkspaceAccessState {
  return { id: row.id, name: row.name, accessState: row.lifecycle_status === 'suspended' ? 'suspended' : 'active',
    ...(row.lifecycle_status === 'suspended' ? {
      publicReason: row.public_reason || 'Contact your workspace administrator for assistance.',
      ...(row.suspended_at ? { suspendedAt: new Date(row.suspended_at).toISOString() } : {})
    } : {}) };
}
export async function getMemberWorkspaceAccessState(userId: string, workspaceId: string): Promise<WorkspaceAccessState | null> {
  const result = await db.query<AccessRow>(`${projection} WHERE m.user_id=$1 AND w.id=$2`, [userId, workspaceId]);
  return result.rowCount ? accessState(result.rows[0]) : null;
}
export async function listMemberWorkspaceAccessStates(userId: string): Promise<WorkspaceAccessState[]> {
  const result = await db.query<AccessRow>(`${projection} WHERE m.user_id=$1 ORDER BY w.created_at,w.id`, [userId]);
  return result.rows.map(accessState);
}
