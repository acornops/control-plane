import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationsDir = path.join(root, 'migrations/control-plane');
const deploymentRoot = path.resolve(root, '../acornops-deployment');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function readDeploymentFile(relativePath) {
  return readFileSync(path.join(deploymentRoot, relativePath), 'utf8');
}

function migrationFiles() {
  return readdirSync(migrationsDir).filter((entry) => entry.endsWith('.sql')).sort();
}

function checksumSql(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

const dbSource = read('src/infra/db.ts');
assert(!dbSource.includes('SCHEMA_SQL'), 'startup must not carry boot-time schema SQL');
assert(!/CREATE TABLE IF NOT EXISTS \w+/i.test(dbSource), 'startup must not create application tables');
assert(!/ALTER TABLE \w+/i.test(dbSource), 'startup must not alter application tables');
assert(dbSource.includes('assertDatabaseMigrationsCurrent'), 'startup must verify migrations are current');

const files = migrationFiles();
assert.deepEqual(files, [
  '001_initial_schema.sql',
  '002_target_skills.sql',
  '003_target_skill_user_defined_markdown_paths.sql',
  '004_target_skill_archive_fallback_metadata.sql'
]);
for (const file of files) {
  assert(/^\d{3,}_[a-z0-9_]+\.sql$/.test(file), `invalid migration filename ${file}`);
  assert(checksumSql(read(`migrations/control-plane/${file}`)).length === 64, `missing checksum coverage for ${file}`);
}

const initial = read('migrations/control-plane/001_initial_schema.sql');
for (const table of [
  'users',
  'user_password_credentials',
  'user_email_verification_tokens',
  'user_password_reset_tokens',
  'user_federated_identities',
  'external_integration_link_tokens',
  'external_integration_user_links',
  'workspaces',
  'workspace_quota_overrides',
  'workspace_ai_settings',
  'workspace_memberships',
  'workspace_membership_audit',
  'workspace_invitations',
  'role_templates',
  'targets',
  'kubernetes_target_settings',
  'target_agent_registrations',
  'target_snapshots',
  'target_snapshot_history',
  'target_inventory_items',
  'target_findings',
  'target_snapshot_summaries',
  'target_tool_overrides',
  'sessions',
  'messages',
  'runs',
  'run_events',
  'run_tool_approvals',
  'run_continuations',
  'chat_activity_events',
  'webhook_subscriptions',
  'webhook_history',
  'workspace_audit_events',
  'admin_audit_events'
]) {
  assert(initial.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `initial migration must create ${table}`);
}
for (const needle of [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'email_verification_required BOOLEAN NOT NULL DEFAULT false',
  'username TEXT UNIQUE NOT NULL',
  'token_hash TEXT UNIQUE NOT NULL',
  'PRIMARY KEY (provider, subject)',
  'plan_key TEXT NOT NULL DEFAULT',
  'CREATE TABLE IF NOT EXISTS workspace_quota_overrides',
  "default_provider TEXT NOT NULL CHECK (default_provider IN ('openai', 'anthropic', 'gemini'))",
  "reasoning_summary_mode TEXT NOT NULL DEFAULT 'auto'",
  "CHECK (reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed'))",
  'reasoning_effort TEXT NOT NULL DEFAULT',
  "CHECK (reasoning_effort IN ('default', 'low', 'medium', 'high'))",
  'source TEXT NOT NULL DEFAULT',
  "kind TEXT NOT NULL CHECK (kind IN ('system', 'custom'))",
  'capabilities JSONB NOT NULL',
  "target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine'))",
  "status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded', 'unknown'))",
  "namespace_include JSONB NOT NULL DEFAULT '[]'::jsonb",
  "namespace_exclude JSONB NOT NULL DEFAULT '[]'::jsonb",
  'write_confirmation_required_override BOOLEAN NULL',
  'location TEXT NULL',
  'inventory_count INTEGER NOT NULL',
  'summary JSONB NOT NULL',
  'last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  "expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')",
  'deleted_at TIMESTAMPTZ NULL',
  "kind TEXT NOT NULL DEFAULT 'user'",
  'client_message_id TEXT NULL',
  'fk_messages_session',
  'fk_runs_session',
  'fk_run_events_run',
  "llm_provider TEXT NOT NULL DEFAULT 'openai' CHECK (llm_provider IN ('openai', 'anthropic', 'gemini'))",
  "llm_model TEXT NOT NULL DEFAULT 'gpt-5.5'",
  "llm_reasoning_summary_mode TEXT NOT NULL DEFAULT 'auto'",
  "CHECK (llm_reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed'))",
  'llm_reasoning_effort TEXT NOT NULL DEFAULT',
  'tool_access_mode TEXT NOT NULL DEFAULT',
  'execution_status TEXT NOT NULL DEFAULT',
  'CREATE TABLE IF NOT EXISTS run_continuations',
  'idx_run_continuations_approval',
  'summary TEXT NULL',
  'CREATE TABLE IF NOT EXISTS chat_activity_events',
  'fk_chat_activity_events_workspace_target',
  'idx_chat_activity_events_target_replay',
  'idx_chat_activity_events_session',
  'CREATE TABLE IF NOT EXISTS workspace_audit_events',
  'workspace_audit_events_category_check',
  'workspace_audit_events_operation_check',
  "operation TEXT NOT NULL",
  "CHECK (operation IN ('read', 'write'))",
  "actor_type IN ('user', 'system', 'admin_token')",
  'actor_token_id TEXT NULL',
  'workspace_audit_events_user_actor_check',
  'workspace_audit_events_metadata_object_check',
  'CREATE TABLE IF NOT EXISTS admin_audit_events',
  'admin_audit_events_metadata_object_check',
  'targets_workspace_id_id_unique',
  'fk_sessions_workspace_target',
  'fk_runs_workspace_target',
  'fk_run_tool_approvals_workspace_target',
  'fk_webhook_subscriptions_workspace_target',
  'fk_webhook_history_workspace_target',
  'fk_target_snapshot_history_workspace_target',
  'idx_user_password_credentials_last_login',
  'idx_user_email_verification_tokens_user_email',
  'idx_user_password_reset_tokens_expires_at',
  'idx_user_federated_identities_user_id',
  'CREATE TABLE IF NOT EXISTS external_integration_link_tokens',
  'integration_client_id TEXT NOT NULL',
  'client_display_name TEXT NOT NULL',
  'external_display_name TEXT NULL',
  'invalidated_at TIMESTAMPTZ NULL',
  'CREATE TABLE IF NOT EXISTS external_integration_user_links',
  'acornops_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'last_authenticated_at TIMESTAMPTZ NOT NULL',
  'revoked_at TIMESTAMPTZ NULL',
  'UNIQUE (integration_client_id, provider, external_user_id)',
  'CREATE TABLE IF NOT EXISTS account_audit_events',
  'idx_external_integration_link_tokens_identity',
  'idx_external_integration_link_tokens_expires_at',
  'idx_external_integration_user_links_user_id',
  'idx_external_integration_user_links_active',
  'idx_external_integration_user_links_user_active',
  'idx_workspaces_created_id',
  'idx_workspace_memberships_workspace_role',
  'idx_workspace_memberships_workspace_role_user',
  'idx_workspace_membership_audit_workspace_created',
  'idx_workspace_invitations_workspace_status',
  'idx_workspace_invitations_workspace_status_created_id',
  'idx_targets_workspace_type_status_created_id',
  'idx_sessions_target_last_message',
  'idx_sessions_workspace_target_last_message_id',
  'idx_messages_session_client_message_id',
  'idx_messages_run_assistant_final',
  'idx_run_tool_approvals_run_call',
  'idx_run_tool_approvals_run_status',
  'idx_target_snapshot_history_target_ts',
  'idx_inventory_items_target_sort',
  'idx_inventory_items_search_trgm',
  'idx_target_findings_target_order',
  'idx_target_findings_workspace_order',
  'idx_target_findings_search_trgm',
  'idx_snapshot_summaries_workspace_target',
  'idx_workspace_audit_events_workspace_occurred',
  'idx_workspace_audit_events_workspace_type',
  'idx_workspace_audit_events_workspace_category',
  'idx_workspace_audit_events_occurred',
  'admin_audit_events_occurred_at_idx',
  'admin_audit_events_workspace_idx',
  'admin_audit_events_token_idx',
  'admin_audit_events_action_idx'
]) {
  assert(initial.includes(needle), `initial migration missing ${needle}`);
}
for (const childResource of ['sessions', 'runs', 'messages', 'run_tool_approvals']) {
  assert(
    !new RegExp(`REFERENCES\\s+${childResource}\\b`, 'i').test(initial.slice(initial.indexOf('CREATE TABLE IF NOT EXISTS chat_activity_events'))),
    `chat_activity_events must keep durable resource ids instead of cascading from ${childResource}`
  );
}
assert(!initial.includes('node TEXT NULL'), 'target inventory items must not expose Kubernetes-only node as a generic column');
assert(!initial.includes('resource_count INTEGER'), 'target snapshot summaries must use target-neutral inventory_count');
assert(!initial.includes('namespace_count INTEGER'), 'target snapshot summaries must not expose Kubernetes-only namespace_count as a generic column');
assert(!initial.includes('node_count INTEGER'), 'target snapshot summaries must not expose Kubernetes-only node_count as a generic column');
assert(!initial.includes('INSERT INTO workspace_audit_events'), 'squashed baseline must not backfill old audit rows');
assert(!initial.includes('ADD COLUMN IF NOT EXISTS'), 'squashed baseline must define columns directly');
const nullableTargetFkCount = [...initial.matchAll(/target_id TEXT NULL REFERENCES targets\(id\) ON DELETE CASCADE/g)].length;
assert(nullableTargetFkCount >= 2, 'webhook target scopes must reference targets with cascade cleanup');
assert(initial.includes('CREATE TABLE IF NOT EXISTS role_templates'), 'initial migration must create role_templates directly');
assert(initial.includes('idx_workspace_memberships_workspace_role'), 'initial migration must index workspace role filtering directly');
assert(!initial.includes('workspace_memberships_role_check'), 'workspace memberships must not use enum-style role constraints');
assert(!initial.includes('workspace_invitations_role_check'), 'workspace invitations must not use enum-style role constraints');
assert(!initial.includes("CHECK (role IN ('owner', 'admin', 'operator', 'viewer"), 'workspace invitations role must not be enum constrained');

const targetSkills = read('migrations/control-plane/002_target_skills.sql');
for (const table of ['target_skills', 'target_skill_files']) {
  assert(targetSkills.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `target skills migration must create ${table}`);
}
for (const needle of [
  "source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'git_import'))",
  "validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid'))",
  "sync_status TEXT NOT NULL CHECK (sync_status IN ('not_applicable', 'current', 'modified'))",
  "file_count INTEGER NOT NULL CHECK (file_count >= 1 AND file_count <= 16)",
  "total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 131072)",
  'target_skills_target_scope_unique',
  'target_skills_source_metadata_check',
  "size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 32768)",
  'target_skill_files_path_check',
  'idx_target_skills_target_updated',
  'idx_target_skills_target_enabled_valid',
  'idx_target_skill_files_skill_path'
]) {
  assert(targetSkills.includes(needle), `target skills migration missing ${needle}`);
}
const targetSkillUserDefinedPaths = read('migrations/control-plane/003_target_skill_user_defined_markdown_paths.sql');
for (const needle of [
  'ALTER TABLE target_skill_files',
  'DROP CONSTRAINT IF EXISTS target_skill_files_path_check',
  'ADD CONSTRAINT target_skill_files_path_check CHECK',
  "path LIKE '%.md'",
  "path NOT LIKE '/%'",
  "path NOT LIKE '%/../%'",
  "path NOT LIKE '%/./%'"
]) {
  assert(targetSkillUserDefinedPaths.includes(needle), `target skill path migration missing ${needle}`);
}
const targetSkillArchiveFallbackMetadata = read('migrations/control-plane/004_target_skill_archive_fallback_metadata.sql');
for (const needle of [
  'DROP CONSTRAINT IF EXISTS target_skills_source_metadata_check',
  'ADD CONSTRAINT target_skills_source_metadata_check CHECK',
  "source_type = 'git_import'",
  'source_repo_url IS NOT NULL',
  'source_ref IS NOT NULL',
  "sync_status IN ('current', 'modified')"
]) {
  assert(targetSkillArchiveFallbackMetadata.includes(needle), `target skill archive fallback migration missing ${needle}`);
}
assert(
  !targetSkillArchiveFallbackMetadata.includes('source_commit_sha IS NOT NULL'),
  'archive fallback metadata migration must allow GitHub imports without source_commit_sha'
);

const packageJson = JSON.parse(read('package.json'));
assert(packageJson.scripts['db:migrate'], 'package must expose db:migrate');
assert(packageJson.scripts['db:status'], 'package must expose db:status');
assert(packageJson.scripts['db:check'], 'package must expose db:check');
assert(packageJson.scripts.validate.includes('migrations:check'), 'validate must include migration checks');

const standaloneCompose = read('docker-compose.yml');
const standaloneOverride = read('docker-compose.override.yml');
for (const content of [standaloneCompose, standaloneOverride]) {
  assert(content.includes('control-plane-init:'), 'deployment compose must define control-plane-init');
  assert(
    content.includes('control-plane-db') || content.includes('db:migrate'),
    'deployment migration job must run control-plane migration CLI'
  );
}
if (existsSync(deploymentRoot)) {
  const localCompose = readDeploymentFile('compose/local/compose.source.yaml');
  const prodCompose = readDeploymentFile('compose/vm-prod/compose.yaml');
  const localUp = readDeploymentFile('scripts/local-up.sh');
  const prodUp = readDeploymentFile('scripts/prod-up.sh');
  for (const content of [localCompose, prodCompose]) {
    assert(content.includes('control-plane-init:'), 'deployment compose must define control-plane-init');
    assert(
      content.includes('control-plane-db') || content.includes('db:migrate'),
      'deployment migration job must run control-plane migration CLI'
    );
  }
  assert(localUp.includes('run --rm --build control-plane-init'), 'local-up must run control-plane migrations before startup');
  assert(prodUp.includes('run --rm control-plane-init'), 'prod-up must run control-plane migrations before startup');
} else {
  console.log('Skipping sibling acornops-deployment migration wiring checks because the deployment repo is not checked out.');
}

async function runSqlChecks(databaseUrl) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const schemaBase = `cp_migration_check_${Date.now()}_${process.pid}`;
  const sqlFiles = files.map((file) => ({ file, sql: read(`migrations/control-plane/${file}`) }));

  async function withSchema(name, work) {
    const client = await pool.connect();
    const schema = `${schemaBase}_${name}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await work(client);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  }

  async function assertFinalSchema(client) {
    for (const [table, column] of [
      ['runs', 'tool_access_mode'],
      ['sessions', 'last_message_at'],
      ['sessions', 'expires_at'],
      ['sessions', 'deleted_at'],
      ['messages', 'kind'],
      ['messages', 'client_message_id'],
      ['workspace_ai_settings', 'reasoning_summary_mode'],
      ['workspace_ai_settings', 'reasoning_effort'],
      ['runs', 'llm_reasoning_summary_mode'],
      ['runs', 'llm_reasoning_effort'],
      ['kubernetes_target_settings', 'namespace_include'],
      ['kubernetes_target_settings', 'namespace_exclude'],
      ['run_tool_approvals', 'summary'],
      ['external_integration_link_tokens', 'integration_client_id'],
      ['external_integration_link_tokens', 'provider'],
      ['external_integration_link_tokens', 'client_display_name'],
      ['external_integration_link_tokens', 'external_display_name'],
      ['external_integration_link_tokens', 'invalidated_at'],
      ['external_integration_user_links', 'integration_client_id'],
      ['external_integration_user_links', 'provider'],
      ['external_integration_user_links', 'client_display_name'],
      ['external_integration_user_links', 'external_display_name'],
      ['external_integration_user_links', 'last_authenticated_at'],
      ['external_integration_user_links', 'revoked_at'],
      ['chat_activity_events', 'payload'],
      ['account_audit_events', 'metadata']
    ]) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [table, column]
      );
      assert.equal(result.rowCount, 1, `${table}.${column} must exist after migrations`);
    }
    const fkResult = await client.query(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace
         AND conname IN (
           'fk_messages_session',
           'fk_runs_session',
           'fk_run_events_run',
           'fk_sessions_workspace_target',
           'fk_runs_workspace_target',
           'fk_run_tool_approvals_workspace_target',
           'fk_chat_activity_events_workspace_target'
         )`
    );
    assert.equal(fkResult.rowCount, 7, 'expected session, run, chat activity, and target-scope foreign keys after migrations');
    const membershipAudit = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'workspace_membership_audit'"
    );
    assert.equal(membershipAudit.rowCount, 1, 'workspace membership audit table must exist after migrations');
    const snapshotHistory = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'target_snapshot_history'"
    );
    assert.equal(snapshotHistory.rowCount, 1, 'target snapshot history table must exist after migrations');
    for (const table of ['target_inventory_items', 'target_findings', 'target_snapshot_summaries']) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      assert.equal(result.rowCount, 1, `${table} must exist after migrations`);
    }
    const passwordCredentials = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'user_password_credentials'"
    );
    assert.equal(passwordCredentials.rowCount, 1, 'password credential table must exist after migrations');
    const workspaceInvitations = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'workspace_invitations'"
    );
    assert.equal(workspaceInvitations.rowCount, 1, 'workspace invitations table must exist after migrations');
    const workspaceAuditEvents = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'workspace_audit_events'"
    );
    assert.equal(workspaceAuditEvents.rowCount, 1, 'workspace audit events table must exist after migrations');
    const accountAuditEvents = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'account_audit_events'"
    );
    assert.equal(accountAuditEvents.rowCount, 1, 'account audit events table must exist after migrations');
    const roleTemplates = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'role_templates'"
    );
    assert.equal(roleTemplates.rowCount, 1, 'role template table must exist after migrations');
    const externalIntegrationLinkTokens = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'external_integration_link_tokens'"
    );
    assert.equal(externalIntegrationLinkTokens.rowCount, 1, 'external integration link token table must exist after migrations');
    const externalIntegrationUserLinks = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'external_integration_user_links'"
    );
    assert.equal(externalIntegrationUserLinks.rowCount, 1, 'external user link table must exist after migrations');
    const roleConstraintResult = await client.query(
      `SELECT conname
       FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace
         AND conname IN ('workspace_invitations_role_check', 'workspace_memberships_role_check')`
    );
    assert.equal(roleConstraintResult.rowCount, 0, 'workspace role storage must not have enum-style role constraints');
  }

  try {
    await withSchema('empty', async (client) => {
      for (const { sql } of sqlFiles) {
        await client.query(sql);
      }
      await assertFinalSchema(client);
    });
  } finally {
    await pool.end();
  }
}

const integrationDatabaseUrl = process.env.CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL;
if (integrationDatabaseUrl) {
  await runSqlChecks(integrationDatabaseUrl);
  console.log('Control-plane migration static and SQL checks passed.');
} else {
  console.log('Control-plane migration static checks passed. Set CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL to run SQL checks.');
}
