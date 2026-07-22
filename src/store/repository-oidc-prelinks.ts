import { randomUUID } from 'node:crypto';
import type { OidcPrelinkedIdentity } from '../config-oidc-prelinks.js';
import { withTransaction } from './repository-transaction.js';

interface UserIdentityRow {
  user_id: string;
  provider: string;
  subject: string;
}

export async function ensureOidcPrelinkedIdentities(
  provider: string,
  identities: OidcPrelinkedIdentity[]
): Promise<void> {
  if (identities.length === 0) return;
  await withTransaction(async (client) => {
    for (const identity of identities) {
      const insertedUser = await client.query<{ id: string }>(
        `INSERT INTO users (
           id, email, display_name, email_verified_at, email_verification_required, created_at
         )
         VALUES ($1, $2, $3, $4, false, NOW())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          identity.email,
          identity.displayName,
          identity.emailVerified ? new Date() : null
        ]
      );
      const userId = insertedUser.rows[0]?.id || (await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 FOR UPDATE',
        [identity.email]
      )).rows[0]?.id;
      if (!userId) {
        throw new Error('OIDC prelink user could not be resolved');
      }

      const existingUserIdentities = await client.query<UserIdentityRow>(
        `SELECT user_id, provider, subject
         FROM user_federated_identities
         WHERE user_id = $1
         FOR UPDATE`,
        [userId]
      );
      const conflictingIdentity = existingUserIdentities.rows.find(
        (existing) => existing.provider !== provider || existing.subject !== identity.subject
      );
      if (conflictingIdentity) {
        throw new Error('OIDC prelink user already has a different federated identity');
      }
      if (existingUserIdentities.rows.length > 0) continue;

      const insertedIdentity = await client.query<{ user_id: string }>(
        `INSERT INTO user_federated_identities (
           user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW(), NULL)
         ON CONFLICT (provider, subject) DO NOTHING
         RETURNING user_id`,
        [userId, provider, identity.subject, identity.email, identity.emailVerified]
      );
      if (insertedIdentity.rowCount) continue;

      const subjectOwner = await client.query<{ user_id: string }>(
        `SELECT user_id
         FROM user_federated_identities
         WHERE provider = $1 AND subject = $2`,
        [provider, identity.subject]
      );
      if (subjectOwner.rows[0]?.user_id !== userId) {
        throw new Error('OIDC prelink subject is linked to another user');
      }
    }
  });
}
