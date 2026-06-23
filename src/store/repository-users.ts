import { randomUUID } from 'node:crypto';
import { db } from '../infra/db.js';
import { AuthMethods, KUBERNETES_TARGET_TYPE, Role, User, VIRTUAL_MACHINE_TARGET_TYPE, Workspace, WorkspaceSummary } from '../types/domain.js';
import { PagedResult, encodeCursor, pageWithCursor } from '../utils/pagination.js';
import { ensureDevelopmentWorkspaceAndTargets } from './repository-development-seed.js';
import {
  CreatePasswordUserResult,
  PasswordCredentialRow,
  PasswordCredentialWithUser,
  UserRow,
  mapUser,
  mapWorkspace,
  mapWorkspaceSummary,
  normalizeRole,
  toIso
} from './repository-mappers.js';
import { withTransaction } from './repository-transaction.js';
import { assertWorkspaceMemberQuota, assertWorkspaceMembershipQuota } from './repository-quotas.js';
const WORKSPACE_SUMMARY_COLUMNS = `w.*,
              m.role AS current_user_role,
              COALESCE(kubernetes_cluster_counts.cluster_count, 0)::int AS cluster_count,
              COALESCE(virtual_machine_counts.virtual_machine_count, 0)::int AS virtual_machine_count,
              COALESCE(member_counts.member_count, 0)::int AS member_count,
              qo.members AS quota_override_members,
              qo.kubernetes_clusters AS quota_override_kubernetes_clusters,
              qo.virtual_machines AS quota_override_virtual_machines`;

const WORKSPACE_SUMMARY_JOINS = `
       INNER JOIN workspace_memberships m ON w.id = m.workspace_id
       LEFT JOIN workspace_quota_overrides qo ON qo.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id, COUNT(*) AS cluster_count
         FROM targets
         WHERE target_type = '${KUBERNETES_TARGET_TYPE}'
         GROUP BY workspace_id
       ) kubernetes_cluster_counts ON kubernetes_cluster_counts.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id, COUNT(*) AS virtual_machine_count
         FROM targets
         WHERE target_type = '${VIRTUAL_MACHINE_TARGET_TYPE}'
         GROUP BY workspace_id
       ) virtual_machine_counts ON virtual_machine_counts.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id, COUNT(*) AS member_count
         FROM workspace_memberships
         GROUP BY workspace_id
       ) member_counts ON member_counts.workspace_id = w.id`;

interface PasswordCredentialOnlyRow {
  user_id: string;
  username: string;
  password_hash: string;
  updated_at: Date | string;
  last_login_at: Date | string | null;
}

interface FederatedIdentityRow {
  user_id: string;
  provider: string;
  subject: string;
  email_at_link_time: string;
  email_verified: boolean | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
  id?: string;
  email?: string;
  display_name?: string;
  user_created_at?: Date | string;
}

type LinkFederatedIdentityResult =
  | { status: 'linked' }
  | { status: 'already_linked_to_user' }
  | { status: 'linked_to_other_user' };

type OidcLoginResolution =
  | { status: 'authenticated'; user: User }
  | { status: 'account_link_required' }
  | { status: 'email_required' }
  | { status: 'email_unverified' };

class FederatedIdentityRaceError extends Error {
  constructor() {
    super('Federated identity was linked concurrently');
  }
}

function mapAuthMethods(
  passwordRows: PasswordCredentialOnlyRow[],
  federatedRows: FederatedIdentityRow[]
): AuthMethods {
  const methods: AuthMethods['methods'] = [
    ...passwordRows.map((row) => ({
      type: 'password' as const,
      username: row.username,
      lastChangedAt: toIso(row.updated_at)!,
      lastLoginAt: toIso(row.last_login_at)
    })),
    ...federatedRows.map((row) => ({
      type: 'oidc' as const,
      provider: row.provider,
      emailAtLinkTime: row.email_at_link_time,
      linkedAt: toIso(row.created_at)!,
      lastLoginAt: toIso(row.last_login_at)
    }))
  ];

  const hasPassword = passwordRows.length > 0;
  const hasOidc = federatedRows.length > 0;
  return {
    methods,
    capabilities: {
      canChangePassword: hasPassword,
      canLinkOidc: hasPassword && !hasOidc,
      canAddPassword: false
    }
  };
}

export async function upsertUser(email: string, displayName: string): Promise<User> {
    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO users (id, email, display_name, email_verified_at, email_verification_required, created_at)
       VALUES ($1, $2, $3, NOW(), false, NOW())
       ON CONFLICT (email) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email_verified_at = COALESCE(users.email_verified_at, NOW()),
           email_verification_required = false
       RETURNING *`,
      [id, email, displayName]
    );
    return mapUser(result.rows[0]);
  }
export async function getUserById(userId: string): Promise<User | null> {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!result.rowCount) return null;
    return mapUser(result.rows[0]);
  }

export async function createPasswordUser(input: {
    email: string;
    username: string;
    displayName: string;
    passwordHash: string;
    emailVerificationRequired?: boolean;
    verificationTokenHash?: string;
    verificationTokenExpiresAt?: Date;
  }): Promise<CreatePasswordUserResult> {
    return withTransaction(async (client) => {
      const existingEmail = await client.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [input.email]);
      if (existingEmail.rowCount) {
        return { status: 'email_exists' };
      }

      const existingUsername = await client.query(
        'SELECT 1 FROM user_password_credentials WHERE username = $1 LIMIT 1',
        [input.username]
      );
      if (existingUsername.rowCount) {
        return { status: 'username_exists' };
      }

      const userId = randomUUID();
      const userResult = await client.query<UserRow>(
        `INSERT INTO users (
           id, email, display_name, email_verified_at, email_verification_required, created_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [
          userId,
          input.email,
          input.displayName,
          input.emailVerificationRequired ? null : new Date(),
          Boolean(input.emailVerificationRequired)
        ]
      );
      await client.query(
        `INSERT INTO user_password_credentials (user_id, username, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [userId, input.username, input.passwordHash]
      );
      if (input.emailVerificationRequired && input.verificationTokenHash && input.verificationTokenExpiresAt) {
        await client.query(
          `INSERT INTO user_email_verification_tokens (
             id, user_id, email, token_hash, expires_at, created_at, last_sent_at
           )
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [randomUUID(), userId, input.email, input.verificationTokenHash, input.verificationTokenExpiresAt]
        );
      }

      return { status: 'created', user: mapUser(userResult.rows[0]) };
    });
  }

export async function getPasswordCredentialByIdentifier(identifier: string): Promise<PasswordCredentialWithUser | null> {
    const result = await db.query<PasswordCredentialRow>(
      `SELECT
         c.user_id,
         c.username,
         c.password_hash,
         c.last_login_at,
         u.id,
         u.email,
         u.display_name,
         u.email_verified_at,
         u.email_verification_required,
         u.created_at
       FROM user_password_credentials c
       INNER JOIN users u ON u.id = c.user_id
       WHERE c.username = $1 OR u.email = $1
       LIMIT 1`,
      [identifier]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      user: mapUser(row),
      username: row.username,
      passwordHash: row.password_hash,
      lastLoginAt: toIso(row.last_login_at),
      emailVerifiedAt: toIso(row.email_verified_at),
      emailVerificationRequired: Boolean(row.email_verification_required)
    };
  }

export async function getPasswordCredentialByUserId(userId: string): Promise<PasswordCredentialOnlyRow | null> {
    const result = await db.query<PasswordCredentialOnlyRow>(
      `SELECT user_id, username, password_hash, updated_at, last_login_at
       FROM user_password_credentials
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  }

export async function markPasswordLoginSuccess(userId: string): Promise<void> {
    await db.query(
      `UPDATE user_password_credentials
       SET last_login_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
  }

export async function updatePasswordCredentialHash(userId: string, passwordHash: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE user_password_credentials
       SET password_hash = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, passwordHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

export async function getAuthMethodsForUser(userId: string): Promise<AuthMethods> {
    const [passwordResult, federatedResult] = await Promise.all([
      db.query<PasswordCredentialOnlyRow>(
        `SELECT user_id, username, password_hash, updated_at, last_login_at
         FROM user_password_credentials
         WHERE user_id = $1`,
        [userId]
      ),
      db.query<FederatedIdentityRow>(
        `SELECT user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at
         FROM user_federated_identities
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [userId]
      )
    ]);
    return mapAuthMethods(passwordResult.rows, federatedResult.rows);
  }

export async function getFederatedIdentityByProviderSubject(
  provider: string,
  subject: string
): Promise<{ user: User; identity: FederatedIdentityRow } | null> {
    const result = await db.query<FederatedIdentityRow>(
      `SELECT
         i.user_id,
         i.provider,
         i.subject,
         i.email_at_link_time,
         i.email_verified,
         i.created_at,
         i.last_login_at,
         u.id,
         u.email,
         u.display_name,
         u.created_at AS user_created_at
       FROM user_federated_identities i
       INNER JOIN users u ON u.id = i.user_id
       WHERE i.provider = $1 AND i.subject = $2
       LIMIT 1`,
      [provider, subject]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      user: mapUser({
        id: row.id!,
        email: row.email!,
        display_name: row.display_name!,
        created_at: row.user_created_at!
      }),
      identity: row
    };
  }

export async function markFederatedIdentityLoginSuccess(provider: string, subject: string): Promise<void> {
    await db.query(
      `UPDATE user_federated_identities
       SET last_login_at = NOW()
       WHERE provider = $1 AND subject = $2`,
      [provider, subject]
    );
  }

export async function linkFederatedIdentity(input: {
    userId: string;
    provider: string;
    subject: string;
    emailAtLinkTime: string;
    emailVerified?: boolean;
  }): Promise<LinkFederatedIdentityResult> {
    return withTransaction(async (client) => {
      const existing = await client.query<FederatedIdentityRow>(
        `SELECT user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at
         FROM user_federated_identities
         WHERE provider = $1 AND subject = $2
         LIMIT 1`,
        [input.provider, input.subject]
      );
      if (existing.rowCount) {
        return existing.rows[0].user_id === input.userId
          ? { status: 'already_linked_to_user' }
          : { status: 'linked_to_other_user' };
      }

      const inserted = await client.query<{ user_id: string }>(
        `INSERT INTO user_federated_identities
           (user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (provider, subject) DO NOTHING
         RETURNING user_id`,
        [input.userId, input.provider, input.subject, input.emailAtLinkTime, input.emailVerified ?? null]
      );
      if (inserted.rowCount) {
        return { status: 'linked' };
      }

      const raced = await client.query<FederatedIdentityRow>(
        `SELECT user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at
         FROM user_federated_identities
         WHERE provider = $1 AND subject = $2
         LIMIT 1`,
        [input.provider, input.subject]
      );
      return raced.rows[0]?.user_id === input.userId
        ? { status: 'already_linked_to_user' }
        : { status: 'linked_to_other_user' };
    });
  }

export async function resolveOidcLogin(input: {
    provider: string;
    subject: string;
    email?: string;
    displayName: string;
    emailVerified?: boolean;
    requireVerifiedEmail: boolean;
  }): Promise<OidcLoginResolution> {
    const existingIdentity = await getFederatedIdentityByProviderSubject(input.provider, input.subject);
    if (existingIdentity) {
      await markFederatedIdentityLoginSuccess(input.provider, input.subject);
      return { status: 'authenticated', user: existingIdentity.user };
    }

    if (!input.email) return { status: 'email_required' };
    if (input.emailVerified === false && input.requireVerifiedEmail) return { status: 'email_unverified' };

    try {
      return await withTransaction(async (client) => {
        const existingUserResult = await client.query<UserRow>(
          `SELECT *
           FROM users
           WHERE email = $1
           LIMIT 1
           FOR UPDATE`,
          [input.email]
        );
        let userRow: UserRow;
        if (existingUserResult.rowCount) {
          const existingUser = existingUserResult.rows[0];
          const passwordResult = await client.query(
            'SELECT 1 FROM user_password_credentials WHERE user_id = $1 LIMIT 1',
            [existingUser.id]
          );
          if (passwordResult.rowCount) {
            return { status: 'account_link_required' };
          }
          const userResult = await client.query<UserRow>(
            `UPDATE users
             SET email_verified_at = COALESCE(email_verified_at, NOW()),
                 email_verification_required = false
             WHERE id = $1
             RETURNING *`,
            [existingUser.id]
          );
          userRow = userResult.rows[0];
        } else {
          const userResult = await client.query<UserRow>(
            `INSERT INTO users (
               id, email, display_name, email_verified_at, email_verification_required, created_at
             )
             VALUES ($1, $2, $3, NOW(), false, NOW())
             RETURNING *`,
            [randomUUID(), input.email, input.displayName]
          );
          userRow = userResult.rows[0];
        }
        const user = mapUser(userRow);
        const passwordResult = await client.query(
          'SELECT 1 FROM user_password_credentials WHERE user_id = $1 LIMIT 1',
          [user.id]
        );
        if (passwordResult.rowCount) {
          return { status: 'account_link_required' };
        }

        const identityResult = await client.query<{ user_id: string }>(
          `INSERT INTO user_federated_identities
             (user_id, provider, subject, email_at_link_time, email_verified, created_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (provider, subject) DO NOTHING
           RETURNING user_id`,
          [user.id, input.provider, input.subject, input.email, input.emailVerified ?? null]
        );
        if (!identityResult.rowCount) {
          throw new FederatedIdentityRaceError();
        }
        return { status: 'authenticated', user };
      });
    } catch (err) {
      if (!(err instanceof FederatedIdentityRaceError)) throw err;
      const racedIdentity = await getFederatedIdentityByProviderSubject(input.provider, input.subject);
      if (racedIdentity) return { status: 'authenticated', user: racedIdentity.user };
      throw err;
    }
  }

export async function addWorkspace(name: string, createdBy: string): Promise<Workspace> {
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await assertWorkspaceMembershipQuota(client, createdBy);
      const wsResult = await client.query(
        'INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [id, name, createdBy]
      );
      await assertWorkspaceMemberQuota(client, id);
      await client.query(
        'INSERT INTO workspace_memberships (workspace_id, user_id, role, source) VALUES ($1, $2, $3, $4)',
        [id, createdBy, 'owner', 'oidc']
      );
      await client.query('COMMIT');
      return mapWorkspace(wsResult.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
export async function listWorkspacesForUser(
  userId: string,
  options: { limit?: number; cursor?: { createdAt: string; workspaceId: string } | null; q?: string; signature?: string } = {}
): Promise<PagedResult<WorkspaceSummary>> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const params: Array<string | number> = [userId, limit + 1];
  const clauses = ['m.user_id = $1'];
  if (options.q) {
    params.push(`%${options.q}%`);
    clauses.push(`LOWER(w.name) LIKE $${params.length}`);
  }
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.workspaceId);
    clauses.push(`(w.created_at, w.id) > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  const result = await db.query(
    `SELECT ${WORKSPACE_SUMMARY_COLUMNS}
     FROM workspaces w
     ${WORKSPACE_SUMMARY_JOINS}
     WHERE ${clauses.join(' AND ')}
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT $2`,
    params
  );
  return pageWithCursor(result.rows.map(mapWorkspaceSummary), limit, (workspace) =>
    encodeCursor({
      signature: options.signature || '',
      createdAt: workspace.createdAt,
      workspaceId: workspace.id
    })
  );
}

export async function getWorkspaceSummaryForUser(userId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
  const result = await db.query(
    `SELECT ${WORKSPACE_SUMMARY_COLUMNS}
     FROM workspaces w
     ${WORKSPACE_SUMMARY_JOINS}
     WHERE w.id = $1 AND m.user_id = $2
     LIMIT 1`,
    [workspaceId, userId]
  );
  return result.rows[0] ? mapWorkspaceSummary(result.rows[0]) : null;
}

export async function userHasWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
    const result = await db.query(
      'SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
      [workspaceId, userId]
    );
    return result.rows.length > 0;
  }
export async function getWorkspaceRole(userId: string, workspaceId: string): Promise<Role | null> {
    const result = await db.query(
      'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
      [workspaceId, userId]
    );
    if (!result.rowCount) return null;
    return normalizeRole(result.rows[0].role);
  }
export const ensureDefaultUser = (): Promise<User> => upsertUser('dev@acornops.local', 'Dev User');
export const ensureDefaultOperatorUser = (): Promise<User> => upsertUser('operator@acornops.local', 'Dev Operator');
export const ensureDevelopmentAccessForUser = (userId: string): Promise<void> => ensureDevelopmentWorkspaceAndTargets(userId);

export async function ensureDevelopmentSeed(seedAgentKey?: string, seedVmAgentKey?: string): Promise<void> {
    const user = await ensureDefaultUser();
    const operator = await ensureDefaultOperatorUser();
    await ensureDevelopmentWorkspaceAndTargets(user.id, seedAgentKey, seedVmAgentKey, [
      { userId: operator.id, role: 'operator' }
    ], true);
  }
