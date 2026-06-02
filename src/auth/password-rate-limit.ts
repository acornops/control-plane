import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { redis } from '../infra/redis.js';

function loginAttemptKey(identifier: string, ipAddress: string): string {
  const identifierHash = createHash('sha256').update(identifier).digest('base64url');
  return `cp:auth:password_attempt:${identifierHash}:${ipAddress}`;
}

function identifierAttemptKey(identifier: string): string {
  const identifierHash = createHash('sha256').update(identifier).digest('base64url');
  return `cp:auth:password_attempt_identifier:${identifierHash}`;
}

function resetRequestKey(identifier: string, ipAddress: string): string {
  const identifierHash = createHash('sha256').update(identifier).digest('base64url');
  return `cp:auth:password_reset_request:${identifierHash}:${ipAddress}`;
}

function resetRequestIdentifierKey(identifier: string): string {
  const identifierHash = createHash('sha256').update(identifier).digest('base64url');
  return `cp:auth:password_reset_request_identifier:${identifierHash}`;
}

async function incrementWindow(key: string, windowSeconds: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count;
}

export async function registerPasswordLoginAttempt(identifier: string, ipAddress: string): Promise<boolean> {
  const [ipCount, identifierCount] = await Promise.all([
    incrementWindow(loginAttemptKey(identifier, ipAddress), config.PASSWORD_AUTH_RATE_LIMIT_WINDOW_SECONDS),
    incrementWindow(identifierAttemptKey(identifier), config.PASSWORD_AUTH_RATE_LIMIT_WINDOW_SECONDS)
  ]);
  return ipCount <= config.PASSWORD_AUTH_MAX_ATTEMPTS &&
    identifierCount <= config.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS;
}

export async function registerPasswordResetRequest(identifier: string, ipAddress: string): Promise<boolean> {
  const [ipCount, identifierCount] = await Promise.all([
    incrementWindow(resetRequestKey(identifier, ipAddress), config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS),
    incrementWindow(resetRequestIdentifierKey(identifier), config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS)
  ]);
  return ipCount <= config.PASSWORD_AUTH_MAX_ATTEMPTS &&
    identifierCount <= config.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS;
}

export async function clearPasswordLoginAttempts(identifier: string, ipAddress: string): Promise<void> {
  await redis.del(loginAttemptKey(identifier, ipAddress), identifierAttemptKey(identifier));
}
