import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';
import { logger } from '../logger.js';

export interface BrowserSession {
  version: 2;
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  authMethod: 'oidc' | 'password' | 'dev';
  oidc?: {
    provider: string;
    issuer: string;
    idToken: string;
  };
}

export type UserSessionAuthContext =
  | { authMethod: 'password' | 'dev' }
  | { authMethod: 'oidc'; provider: string; issuer: string; idToken: string };

type StoredSessionRecord = Record<string, unknown>;

const refreshSessionIfPresentScript = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  return 0
end
redis.call("SETEX", KEYS[1], ARGV[1], ARGV[2])
return 1
`;

const createSessionScript = `
redis.call("SETEX", KEYS[1], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[2], ARGV[3])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return 1
`;

const revokeUserSessionsScript = `
local session_ids = redis.call("SMEMBERS", KEYS[1])
local revoked = 0
for _, session_id in ipairs(session_ids) do
  revoked = revoked + redis.call("DEL", ARGV[1] .. session_id)
end
redis.call("DEL", KEYS[1])
return revoked
`;

const rotateUserSessionsScript = `
local session_ids = redis.call("SMEMBERS", KEYS[1])
for _, session_id in ipairs(session_ids) do
  redis.call("DEL", ARGV[1] .. session_id)
end
redis.call("DEL", KEYS[1])
redis.call("SETEX", KEYS[2], ARGV[2], ARGV[3])
redis.call("SADD", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[1], ARGV[5])
return 1
`;

const replaceSessionIfPresentScript = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  return 0
end
redis.call("DEL", KEYS[1])
redis.call("SREM", KEYS[3], ARGV[1])
redis.call("SETEX", KEYS[2], ARGV[2], ARGV[3])
redis.call("SADD", KEYS[3], ARGV[4])
redis.call("EXPIRE", KEYS[3], ARGV[5])
return 1
`;

const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

function sessionKey(id: string): string {
  return `cp:session:${id}`;
}

function userSessionSetKey(userId: string): string {
  return `cp:user_sessions:${userId}`;
}

function sessionRedisTtlSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

function parseStoredSessionRecord(raw: string): StoredSessionRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StoredSessionRecord
      : null;
  } catch {
    return null;
  }
}

function hasUserId(session: StoredSessionRecord): session is StoredSessionRecord & { userId: string } {
  return typeof session.userId === 'string' && session.userId.length > 0;
}

function hasSessionId(session: StoredSessionRecord): session is StoredSessionRecord & { id: string } {
  return typeof session.id === 'string' && session.id.length > 0;
}

function timestampMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCurrentSessionRecord(session: StoredSessionRecord): session is StoredSessionRecord & BrowserSession {
  const current = session as unknown as BrowserSession;
  const createdAt = timestampMillis(current.createdAt);
  const lastSeenAt = timestampMillis(current.lastSeenAt);
  const absoluteExpiresAt = timestampMillis(current.absoluteExpiresAt);
  const idleExpiresAt = timestampMillis(current.idleExpiresAt);
  const hasValidAuthContext = current.authMethod === 'oidc' ? (
    current.oidc !== undefined
    && typeof current.oidc.provider === 'string'
    && current.oidc.provider.length > 0
    && typeof current.oidc.issuer === 'string'
    && current.oidc.issuer.length > 0
    && typeof current.oidc.idToken === 'string'
    && current.oidc.idToken.length > 0
  ) : current.oidc === undefined;
  return (
    current.version === 2 &&
    hasSessionId(session) &&
    hasUserId(session) &&
    createdAt !== null &&
    lastSeenAt !== null &&
    absoluteExpiresAt !== null &&
    idleExpiresAt !== null &&
    createdAt <= lastSeenAt &&
    lastSeenAt <= idleExpiresAt &&
    idleExpiresAt <= absoluteExpiresAt &&
    ['oidc', 'password', 'dev'].includes(current.authMethod) &&
    hasValidAuthContext
  );
}

function refreshedSessionRecord(session: BrowserSession, now: number): BrowserSession {
  const absoluteExpiresAt = timestampMillis(session.absoluteExpiresAt) as number;
  return {
    ...session,
    lastSeenAt: new Date(now).toISOString(),
    idleExpiresAt: new Date(Math.min(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000, absoluteExpiresAt)).toISOString()
  };
}

async function deleteStoredSession(session: StoredSessionRecord, sessionId: string): Promise<void> {
  await redis.del(sessionKey(sessionId));
  if (hasUserId(session)) {
    try {
      await redis.srem(userSessionSetKey(session.userId), sessionId);
    } catch (err) {
      logger.warn({ err, userId: session.userId }, 'Browser session index cleanup failed after session deletion');
    }
  }
}

function newSessionRecord(
  id: string,
  userId: string,
  authContext: UserSessionAuthContext,
  now: number
): { record: BrowserSession; idleExpiresAtMillis: number } {
  const absoluteExpiresAtMillis = now + config.SESSION_MAX_AGE_SECONDS * 1000;
  const idleExpiresAtMillis = Math.min(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000, absoluteExpiresAtMillis);
  const record: BrowserSession = {
    version: 2,
    id,
    userId,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    absoluteExpiresAt: new Date(absoluteExpiresAtMillis).toISOString(),
    idleExpiresAt: new Date(idleExpiresAtMillis).toISOString(),
    authMethod: authContext.authMethod,
    ...(authContext.authMethod === 'oidc' ? {
      oidc: {
        provider: authContext.provider,
        issuer: authContext.issuer,
        idToken: authContext.idToken
      }
    } : {})
  };
  return { record, idleExpiresAtMillis };
}

export async function createUserSession(userId: string, authContext: UserSessionAuthContext): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const { record, idleExpiresAtMillis } = newSessionRecord(id, userId, authContext, now);
  await redis.eval(
    createSessionScript,
    2,
    sessionKey(id),
    userSessionSetKey(userId),
    String(sessionRedisTtlSeconds(idleExpiresAtMillis, now)),
    JSON.stringify(record),
    id,
    String(config.SESSION_MAX_AGE_SECONDS)
  );
  return id;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(config.SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: config.SESSION_MAX_AGE_SECONDS * 1000,
    path: '/'
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}

export async function deleteUserSession(sessionId: string): Promise<BrowserSession | null> {
  if (!sessionIdPattern.test(sessionId)) return null;
  const raw = await redis.getdel(sessionKey(sessionId));
  let activeSession: BrowserSession | null = null;
  if (raw) {
    const session = parseStoredSessionRecord(raw);
    if (session && hasUserId(session)) {
      try {
        await redis.srem(userSessionSetKey(session.userId), sessionId);
      } catch (err) {
        logger.warn({ err, userId: session.userId }, 'Browser session index cleanup failed after logout');
      }
    }
    if (session && isCurrentSessionRecord(session)) {
      const now = Date.now();
      const absoluteExpiresAt = timestampMillis(session.absoluteExpiresAt) as number;
      const idleExpiresAt = timestampMillis(session.idleExpiresAt) as number;
      if (session.id === sessionId && now < absoluteExpiresAt && now < idleExpiresAt) {
        activeSession = session;
      }
    }
  }
  return activeSession;
}

export async function rotateUserSessions(userId: string, authContext: UserSessionAuthContext): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const { record, idleExpiresAtMillis } = newSessionRecord(id, userId, authContext, now);
  await redis.eval(
    rotateUserSessionsScript,
    2,
    userSessionSetKey(userId),
    sessionKey(id),
    'cp:session:',
    String(sessionRedisTtlSeconds(idleExpiresAtMillis, now)),
    JSON.stringify(record),
    id,
    String(config.SESSION_MAX_AGE_SECONDS)
  );
  return id;
}

export async function replaceUserSession(
  oldSessionId: string,
  userId: string,
  authContext: UserSessionAuthContext
): Promise<string | null> {
  if (!sessionIdPattern.test(oldSessionId)) return null;
  const id = randomUUID();
  const now = Date.now();
  const { record, idleExpiresAtMillis } = newSessionRecord(id, userId, authContext, now);
  const replaced = await redis.eval(
    replaceSessionIfPresentScript,
    3,
    sessionKey(oldSessionId),
    sessionKey(id),
    userSessionSetKey(userId),
    oldSessionId,
    String(sessionRedisTtlSeconds(idleExpiresAtMillis, now)),
    JSON.stringify(record),
    id,
    String(config.SESSION_MAX_AGE_SECONDS)
  );
  return replaced === 1 ? id : null;
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await redis.eval(revokeUserSessionsScript, 1, userSessionSetKey(userId), 'cp:session:');
}

export async function revokeUserSessionsWithCount(userId: string): Promise<number> {
  const revoked = await redis.eval(revokeUserSessionsScript, 1, userSessionSetKey(userId), 'cp:session:');
  return Number(revoked);
}

export async function countUserSessions(userId: string): Promise<number> {
  const sessionIds = await redis.smembers(userSessionSetKey(userId));
  if (sessionIds.length === 0) return 0;
  return redis.exists(...sessionIds.map(sessionKey));
}

export async function getSessionUser(req: Request): Promise<{ userId: string; sessionId: string } | null> {
  const sid = req.cookies?.[config.SESSION_COOKIE_NAME] as unknown;
  if (typeof sid !== 'string' || !sessionIdPattern.test(sid)) return null;
  const raw = await redis.get(sessionKey(sid));
  if (!raw) return null;
  const session = parseStoredSessionRecord(raw);
  if (!session) {
    await redis.del(sessionKey(sid));
    return null;
  }
  if (!hasSessionId(session) || session.id !== sid) {
    await deleteStoredSession(session, sid);
    return null;
  }
  const now = Date.now();
  if (isCurrentSessionRecord(session)) {
    const absoluteExpiresAt = timestampMillis(session.absoluteExpiresAt) as number;
    const idleExpiresAt = timestampMillis(session.idleExpiresAt) as number;
    if (now >= absoluteExpiresAt || now >= idleExpiresAt) {
      await deleteStoredSession(session, sid);
      return null;
    }
    const refreshedSession = refreshedSessionRecord(session, now);
    const refreshed = await redis.eval(
      refreshSessionIfPresentScript,
      1,
      sessionKey(sid),
      String(sessionRedisTtlSeconds(timestampMillis(refreshedSession.idleExpiresAt) as number, now)),
      JSON.stringify(refreshedSession)
    );
    if (refreshed !== 1) return null;
    return { userId: session.userId, sessionId: sid };
  }
  await deleteStoredSession(session, sid);
  return null;
}
