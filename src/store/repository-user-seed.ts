import type { User } from '../types/domain.js';
import { ensureDevelopmentWorkspaceAndTargets } from './repository-development-seed.js';
import { upsertUser } from './repository-users.js';

export const ensureDefaultUser = (): Promise<User> => upsertUser('dev@acornops.local', 'Dev User');
export const ensureDefaultOperatorUser = (): Promise<User> => upsertUser('operator@acornops.local', 'Dev Operator');
export const ensureDefaultAdminUser = (): Promise<User> => upsertUser('admin@acornops.local', 'Casey Admin');
export const ensureDefaultOwnerBackupUser = (): Promise<User> => upsertUser('owner.backup@acornops.local', 'Morgan Backup Owner');
export const ensureDefaultViewerUser = (): Promise<User> => upsertUser('viewer@acornops.local', 'Riley Viewer');
export const ensureDefaultAuditorUser = (): Promise<User> => upsertUser('auditor@acornops.local', 'Jordan Auditor');
export const ensureDefaultLongNameUser = (): Promise<User> =>
  upsertUser('avery.long.email-address-for-layout-review@acornops.local', 'Avery Long-Name Layout Review');
export const ensureDevelopmentAccessForUser = (userId: string): Promise<void> => ensureDevelopmentWorkspaceAndTargets(userId);

export async function ensureDevelopmentSeed(seedAgentKey?: string, seedVmAgentKey?: string): Promise<void> {
  const user = await ensureDefaultUser();
  const operator = await ensureDefaultOperatorUser();
  const admin = await ensureDefaultAdminUser();
  const backupOwner = await ensureDefaultOwnerBackupUser();
  const viewer = await ensureDefaultViewerUser();
  const auditor = await ensureDefaultAuditorUser();
  const longNameViewer = await ensureDefaultLongNameUser();
  await ensureDevelopmentWorkspaceAndTargets(user.id, seedAgentKey, seedVmAgentKey, [
    { userId: backupOwner.id, role: 'owner' },
    { userId: admin.id, role: 'admin' },
    { userId: operator.id, role: 'operator' },
    { userId: viewer.id, role: 'viewer' },
    { userId: auditor.id, role: 'auditor' },
    { userId: longNameViewer.id, role: 'viewer' }
  ], true, [
    {
      email: 'new.admin.invite@acornops.local',
      role: 'admin',
      status: 'pending',
      createdOffsetDays: -1,
      expiresOffsetDays: 6,
      token: 'wi_dev_pending_admin'
    },
    {
      email: 'read.only.contractor@acornops.local',
      role: 'viewer',
      status: 'pending',
      createdOffsetDays: -3,
      expiresOffsetDays: 4,
      token: 'wi_dev_pending_viewer'
    },
    {
      email: 'expired.auditor.invite@acornops.local',
      role: 'auditor',
      status: 'expired',
      createdOffsetDays: -14,
      expiresOffsetDays: -7,
      token: 'wi_dev_expired_auditor'
    }
  ]);
}
