import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';

interface CurrentSessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
}

type StoredSessionRecord = CurrentSessionRecord;

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

function isCurrentSessionRecord(session: StoredSessionRecord): session is CurrentSessionRecord {
  const current = session as CurrentSessionRecord;
  return (
    hasSessionId(session) &&
    hasUserId(session) &&
    Number.isFinite(current.createdAt) &&
    Number.isFinite(current.lastSeenAt) &&
    Number.isFinite(current.absoluteExpiresAt) &&
    Number.isFinite(current.idleExpiresAt)
  );
}

function refreshedSessionRecord(session: CurrentSessionRecord, now: number): CurrentSessionRecord {
  return {
    ...session,
    lastSeenAt: now,
    idleExpiresAt: Math.min(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000, session.absoluteExpiresAt)
  };
}

async function deleteStoredSession(session: StoredSessionRecord, sessionId: string): Promise<void> {
  if (hasUserId(session)) {
    await redis.srem(userSessionSetKey(session.userId), sessionId);
  }
  await redis.del(sessionKey(sessionId));
}

export async function createUserSession(userId: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const absoluteExpiresAt = now + config.SESSION_MAX_AGE_SECONDS * 1000;
  const idleExpiresAt = Math.min(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000, absoluteExpiresAt);
  const record: CurrentSessionRecord = {
    id,
    userId,
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt,
    idleExpiresAt
  };
  await redis.setex(sessionKey(id), sessionRedisTtlSeconds(idleExpiresAt, now), JSON.stringify(record));
  await redis.sadd(userSessionSetKey(userId), id);
  await redis.expire(userSessionSetKey(userId), config.SESSION_MAX_AGE_SECONDS);
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

export async function deleteUserSession(sessionId: string): Promise<void> {
  const raw = await redis.get(sessionKey(sessionId));
  if (raw) {
    const session = parseStoredSessionRecord(raw);
    if (session && hasUserId(session)) {
      await redis.srem(userSessionSetKey(session.userId), sessionId);
    }
  }
  await redis.del(sessionKey(sessionId));
}

export async function rotateUserSessions(userId: string): Promise<string> {
  const key = userSessionSetKey(userId);
  const sessionIds = await redis.smembers(key);
  if (sessionIds.length > 0) {
    await redis.del(...sessionIds.map(sessionKey));
  }
  await redis.del(key);
  return createUserSession(userId);
}

export async function revokeUserSessions(userId: string): Promise<void> {
  const key = userSessionSetKey(userId);
  const sessionIds = await redis.smembers(key);
  if (sessionIds.length > 0) {
    await redis.del(...sessionIds.map(sessionKey));
  }
  await redis.del(key);
}

export async function revokeUserSessionsWithCount(userId: string): Promise<number> {
  const key = userSessionSetKey(userId);
  const sessionIds = await redis.smembers(key);
  const activeSessionCount = sessionIds.length > 0 ? await redis.exists(...sessionIds.map(sessionKey)) : 0;
  if (sessionIds.length > 0) {
    await redis.del(...sessionIds.map(sessionKey));
  }
  await redis.del(key);
  return activeSessionCount;
}

export async function countUserSessions(userId: string): Promise<number> {
  const sessionIds = await redis.smembers(userSessionSetKey(userId));
  if (sessionIds.length === 0) return 0;
  return redis.exists(...sessionIds.map(sessionKey));
}

export async function getSessionUser(req: Request): Promise<{ userId: string; sessionId: string } | null> {
  const sid = req.cookies?.[config.SESSION_COOKIE_NAME] as unknown;
  if (typeof sid !== 'string' || sid.length === 0) return null;
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
    if (now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) {
      await deleteStoredSession(session, sid);
      return null;
    }
    const refreshedSession = refreshedSessionRecord(session, now);
    await redis.setex(
      sessionKey(sid),
      sessionRedisTtlSeconds(refreshedSession.idleExpiresAt, now),
      JSON.stringify(refreshedSession)
    );
    return { userId: session.userId, sessionId: sid };
  }
  await deleteStoredSession(session, sid);
  return null;
}
