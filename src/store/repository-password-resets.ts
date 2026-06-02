import { randomUUID } from 'node:crypto';
import { User } from '../types/domain.js';
import { mapUser, UserRow } from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';

interface PasswordResetTokenRow {
  id: string;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  created_at: Date | string;
  last_sent_at: Date | string;
}

interface PasswordResetContextRow extends UserRow {
  username: string;
  token_consumed_at: Date | string | null;
  token_expires_at: Date | string;
}

export async function preparePasswordResetRequest(input: {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  requestWindowSeconds: number;
}): Promise<
  | { status: 'rotated'; email: string; expiresAt: Date }
  | { status: 'throttled'; email: string; resendAfterSeconds: number }
  | { status: 'noop' }
> {
  return withTransaction(async (client) => {
    const userResult = await client.query<UserRow & { username: string }>(
      `SELECT u.*, c.username
       FROM users u
       INNER JOIN user_password_credentials c ON c.user_id = u.id
       WHERE u.email = $1
       LIMIT 1
       FOR UPDATE OF u`,
      [input.email]
    );
    if (!userResult.rowCount) return { status: 'noop' };
    const user = userResult.rows[0];

    const latestToken = await client.query<PasswordResetTokenRow>(
      `SELECT *
       FROM user_password_reset_tokens
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
      const resendAt = new Date(lastSentAt).getTime() + input.requestWindowSeconds * 1000;
      if (resendAt > Date.now()) {
        return {
          status: 'throttled',
          email: input.email,
          resendAfterSeconds: Math.ceil((resendAt - Date.now()) / 1000)
        };
      }
    }

    await client.query(
      `INSERT INTO user_password_reset_tokens (
         id, user_id, email, token_hash, expires_at, created_at, last_sent_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [randomUUID(), user.id, input.email, input.tokenHash, input.expiresAt]
    );
    return { status: 'rotated', email: input.email, expiresAt: input.expiresAt };
  });
}

export async function getPasswordResetTokenContext(tokenHash: string): Promise<
  | { status: 'valid'; user: User; username: string }
  | { status: 'invalid' }
  | { status: 'expired' }
> {
  return withTransaction(async (client) => {
    const tokenResult = await client.query<PasswordResetContextRow>(
      `SELECT
         u.id,
         u.email,
         u.display_name,
         u.email_verified_at,
         u.email_verification_required,
         u.created_at,
         c.username,
         t.consumed_at AS token_consumed_at,
         t.expires_at AS token_expires_at
       FROM user_password_reset_tokens t
       INNER JOIN users u ON u.id = t.user_id
       INNER JOIN user_password_credentials c ON c.user_id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [tokenHash]
    );
    if (!tokenResult.rowCount) return { status: 'invalid' };

    const row = tokenResult.rows[0];
    if (row.token_consumed_at) return { status: 'invalid' };
    if (new Date(row.token_expires_at).getTime() <= Date.now()) return { status: 'expired' };
    return { status: 'valid', user: mapUser(row), username: row.username };
  });
}

export async function consumePasswordResetToken(input: {
  tokenHash: string;
  passwordHash: string;
}): Promise<
  | { status: 'reset'; user: User }
  | { status: 'invalid' }
  | { status: 'expired' }
> {
  return withTransaction(async (client) => {
    const tokenResult = await client.query<PasswordResetTokenRow>(
      `SELECT t.*
       FROM user_password_reset_tokens t
       INNER JOIN user_password_credentials c ON c.user_id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE OF t`,
      [input.tokenHash]
    );
    if (!tokenResult.rowCount) return { status: 'invalid' };

    const token = tokenResult.rows[0];
    if (token.consumed_at) return { status: 'invalid' };
    if (new Date(token.expires_at).getTime() <= Date.now()) return { status: 'expired' };

    await client.query(
      `UPDATE user_password_credentials
       SET password_hash = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [token.user_id, input.passwordHash]
    );
    const userResult = await client.query<UserRow>(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, NOW()),
           email_verification_required = false
       WHERE id = $1
         AND email = $2
       RETURNING *`,
      [token.user_id, token.email]
    );
    if (!userResult.rowCount) return { status: 'invalid' };

    await client.query(
      `UPDATE user_password_reset_tokens
       SET consumed_at = COALESCE(consumed_at, NOW())
       WHERE user_id = $1 AND email = $2 AND consumed_at IS NULL`,
      [token.user_id, token.email]
    );
    await client.query(
      `UPDATE user_email_verification_tokens
       SET consumed_at = COALESCE(consumed_at, NOW())
       WHERE user_id = $1 AND email = $2 AND consumed_at IS NULL`,
      [token.user_id, token.email]
    );

    return { status: 'reset', user: mapUser(userResult.rows[0]) };
  });
}

export async function invalidatePasswordResetToken(tokenHash: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE user_password_reset_tokens
       SET consumed_at = COALESCE(consumed_at, NOW())
       WHERE token_hash = $1`,
      [tokenHash]
    );
  });
}
