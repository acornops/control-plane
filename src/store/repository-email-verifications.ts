import { randomUUID } from 'node:crypto';
import { User } from '../types/domain.js';
import { mapUser, UserRow } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  created_at: Date | string;
  last_sent_at: Date | string;
}

export async function consumeEmailVerificationToken(tokenHash: string): Promise<
  | { status: 'verified'; user: User }
  | { status: 'invalid' }
  | { status: 'expired' }
> {
  return withTransaction(async (client) => {
    const tokenResult = await client.query<EmailVerificationTokenRow>(
      `SELECT t.*
       FROM user_email_verification_tokens t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [tokenHash]
    );
    if (!tokenResult.rowCount) return { status: 'invalid' };

    const token = tokenResult.rows[0];
    if (token.consumed_at) return { status: 'invalid' };
    if (new Date(token.expires_at).getTime() <= Date.now()) return { status: 'expired' };

    const userResult = await client.query<UserRow>(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, NOW()),
           email_verification_required = false
       WHERE id = $1
         AND email = $2
         AND email_verified_at IS NULL
         AND email_verification_required = true
       RETURNING *`,
      [token.user_id, token.email]
    );
    if (!userResult.rowCount) return { status: 'invalid' };
    await client.query(
      `UPDATE user_email_verification_tokens
       SET consumed_at = NOW()
       WHERE user_id = $1 AND email = $2 AND consumed_at IS NULL`,
      [token.user_id, token.email]
    );
    return { status: 'verified', user: mapUser(userResult.rows[0]) };
  });
}

export async function prepareEmailVerificationResend(input: {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  resendWindowSeconds: number;
}): Promise<
  | { status: 'rotated'; email: string; expiresAt: Date }
  | { status: 'throttled'; email: string; resendAfterSeconds: number }
  | { status: 'noop' }
> {
  return withTransaction(async (client) => {
    const userResult = await client.query<UserRow>(
      `SELECT *
       FROM users
       WHERE email = $1
       LIMIT 1
       FOR UPDATE`,
      [input.email]
    );
    if (!userResult.rowCount) return { status: 'noop' };
    const user = userResult.rows[0];
    if (!user.email_verification_required || user.email_verified_at) return { status: 'noop' };

    const latestToken = await client.query<EmailVerificationTokenRow>(
      `SELECT *
       FROM user_email_verification_tokens
       WHERE user_id = $1
         AND email = $2
         AND consumed_at IS NULL
         AND expires_at > NOW()
       ORDER BY last_sent_at DESC
       LIMIT 1
       FOR UPDATE`,
      [user.id, input.email]
    );
    const lastSentAt = latestToken.rows[0]?.last_sent_at;
    if (lastSentAt) {
      const resendAt = new Date(lastSentAt).getTime() + input.resendWindowSeconds * 1000;
      if (resendAt > Date.now()) {
        return {
          status: 'throttled',
          email: input.email,
          resendAfterSeconds: Math.ceil((resendAt - Date.now()) / 1000)
        };
      }
    }

    await client.query(
      `INSERT INTO user_email_verification_tokens (
         id, user_id, email, token_hash, expires_at, created_at, last_sent_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [randomUUID(), user.id, input.email, input.tokenHash, input.expiresAt]
    );
    return { status: 'rotated', email: input.email, expiresAt: input.expiresAt };
  });
}

export async function invalidateEmailVerificationToken(tokenHash: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE user_email_verification_tokens
       SET consumed_at = COALESCE(consumed_at, NOW())
       WHERE token_hash = $1`,
      [tokenHash]
    );
  });
}

export async function retireOtherEmailVerificationTokens(tokenHash: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `WITH target_token AS (
         SELECT user_id, email
         FROM user_email_verification_tokens
         WHERE token_hash = $1
       )
       UPDATE user_email_verification_tokens t
       SET consumed_at = COALESCE(t.consumed_at, NOW())
       FROM target_token
       WHERE t.user_id = target_token.user_id
         AND t.email = target_token.email
         AND t.token_hash <> $1
         AND t.consumed_at IS NULL`,
      [tokenHash]
    );
  });
}
