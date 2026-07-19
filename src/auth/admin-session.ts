import { createHash, randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import type { AdminScope } from '../config.js';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';

export const PLATFORM_ADMIN_ROLES = ['platform-admin', 'platform-admin-viewer', 'platform-admin-auditor'] as const;
export type PlatformAdminRole = typeof PLATFORM_ADMIN_ROLES[number];

const ROLE_SCOPES: Record<PlatformAdminRole, AdminScope[]> = {
  'platform-admin': ['admin:self', 'admin:system:read', 'admin:workspace:read', 'admin:workspace:write', 'admin:user:read', 'admin:member:write', 'admin:audit:read'],
  'platform-admin-viewer': ['admin:self', 'admin:system:read', 'admin:workspace:read', 'admin:user:read'],
  'platform-admin-auditor': ['admin:self', 'admin:audit:read']
};

export interface AdminSessionIdentity {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  roles: PlatformAdminRole[];
  acr?: string;
  amr: string[];
  authenticatedAt: number;
}

export interface AdminSessionRecord extends AdminSessionIdentity {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
}

function key(id: string): string { return `cp:admin_session:${id}`; }
function ttl(expiresAt: number, now: number): number { return Math.max(1, Math.ceil((expiresAt - now) / 1000)); }

export function adminScopesForRoles(roles: PlatformAdminRole[]): AdminScope[] {
  return Array.from(new Set(roles.flatMap((role) => ROLE_SCOPES[role] || [])));
}

export function adminSessionReference(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export async function createAdminSession(identity: AdminSessionIdentity): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const absoluteExpiresAt = now + config.ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
  const record: AdminSessionRecord = {
    ...identity,
    id,
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt,
    idleExpiresAt: Math.min(now + config.ADMIN_SESSION_IDLE_TIMEOUT_SECONDS * 1000, absoluteExpiresAt)
  };
  await redis.setex(key(id), ttl(record.idleExpiresAt, now), JSON.stringify(record));
  return id;
}

export function setAdminSessionCookie(res: Response, id: string): void {
  res.cookie(config.ADMIN_SESSION_COOKIE_NAME, id, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: config.ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
    path: '/'
  });
}

export function clearAdminSessionCookie(res: Response): void {
  res.clearCookie(config.ADMIN_SESSION_COOKIE_NAME, { path: '/' });
}

export async function deleteAdminSession(id: string): Promise<void> {
  await redis.del(key(id));
}

export async function getAdminSession(req: Request): Promise<AdminSessionRecord | null> {
  const id = req.cookies?.[config.ADMIN_SESSION_COOKIE_NAME] as unknown;
  if (typeof id !== 'string' || !id) return null;
  const raw = await redis.get(key(id));
  if (!raw) return null;
  let record: AdminSessionRecord;
  try { record = JSON.parse(raw) as AdminSessionRecord; }
  catch { await redis.del(key(id)); return null; }
  const now = Date.now();
  if (record.id !== id || now >= record.absoluteExpiresAt || now >= record.idleExpiresAt) {
    await redis.del(key(id));
    return null;
  }
  record.lastSeenAt = now;
  record.idleExpiresAt = Math.min(now + config.ADMIN_SESSION_IDLE_TIMEOUT_SECONDS * 1000, record.absoluteExpiresAt);
  await redis.setex(key(id), ttl(record.idleExpiresAt, now), JSON.stringify(record));
  return record;
}

export function adminSessionNeedsReauthentication(record: AdminSessionRecord): boolean {
  return Date.now() - record.authenticatedAt > config.ADMIN_SESSION_REAUTH_SECONDS * 1000;
}
