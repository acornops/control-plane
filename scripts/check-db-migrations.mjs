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
  '002_session_run_and_fk_upgrades.sql',
  '003_workspace_membership_audit.sql',
  '004_target_snapshot_history.sql',
  '005_kubernetes_namespace_scope.sql',
  '006_password_auth.sql',
  '007_workspace_invitations.sql',
  '009_write_tool_approvals.sql',
  '010_auth_methods.sql',
  '011_paged_list_indexes.sql',
  '012_workspace_audit_events.sql',
  '013_admin_api.sql',
  '014_workspace_ai_settings.sql',
  '015_run_llm_snapshot.sql',
  '016_reasoning_summaries.sql'
]);
for (const file of files) {
  assert(/^\d{3,}_[a-z0-9_]+\.sql$/.test(file), `invalid migration filename ${file}`);
  assert(checksumSql(read(`migrations/control-plane/${file}`)).length === 64, `missing checksum coverage for ${file}`);
}

const initial = read('migrations/control-plane/001_initial_schema.sql');
const upgrade = read('migrations/control-plane/002_session_run_and_fk_upgrades.sql');
const membershipUpgrade = read('migrations/control-plane/003_workspace_membership_audit.sql');
const snapshotHistoryUpgrade = read('migrations/control-plane/004_target_snapshot_history.sql');
const namespaceScopeUpgrade = read('migrations/control-plane/005_kubernetes_namespace_scope.sql');
const passwordAuthUpgrade = read('migrations/control-plane/006_password_auth.sql');
const workspaceInvitationsUpgrade = read('migrations/control-plane/007_workspace_invitations.sql');
const writeToolApprovalsUpgrade = read('migrations/control-plane/009_write_tool_approvals.sql');
const authMethodsUpgrade = read('migrations/control-plane/010_auth_methods.sql');
const pagedListIndexesUpgrade = read('migrations/control-plane/011_paged_list_indexes.sql');
const workspaceAuditEventsUpgrade = read('migrations/control-plane/012_workspace_audit_events.sql');
const adminApiUpgrade = read('migrations/control-plane/013_admin_api.sql');
const workspaceAiSettingsUpgrade = read('migrations/control-plane/014_workspace_ai_settings.sql');
const runLlmSnapshotUpgrade = read('migrations/control-plane/015_run_llm_snapshot.sql');
const reasoningSummariesUpgrade = read('migrations/control-plane/016_reasoning_summaries.sql');
for (const table of [
  'users',
  'workspaces',
  'workspace_memberships',
  'role_templates',
  'targets',
  'kubernetes_target_settings',
  'target_agent_registrations',
  'target_snapshots',
  'target_inventory_items',
  'target_findings',
  'target_snapshot_summaries',
  'target_tool_overrides',
  'sessions',
  'messages',
  'runs',
  'run_events',
  'webhook_subscriptions',
  'webhook_history',
  'workspace_ai_settings'
]) {
  assert(initial.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `initial migration must create ${table}`);
}
for (const needle of [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  "kind TEXT NOT NULL CHECK (kind IN ('system', 'custom'))",
  'capabilities JSONB NOT NULL',
  "target_type TEXT NOT NULL CHECK (target_type IN ('kubernetes', 'virtual_machine'))",
  "status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded', 'unknown'))",
  'location TEXT NULL',
  'inventory_count INTEGER NOT NULL',
  'summary JSONB NOT NULL',
  'targets_workspace_id_id_unique',
  'fk_sessions_workspace_target',
  'fk_runs_workspace_target',
  'fk_webhook_subscriptions_workspace_target',
  'fk_webhook_history_workspace_target',
  "llm_provider TEXT NOT NULL CHECK (llm_provider IN ('openai', 'anthropic', 'gemini'))",
  'llm_model TEXT NOT NULL',
  'idx_inventory_items_target_sort',
  'idx_inventory_items_search_trgm',
  'idx_target_findings_target_order',
  'idx_target_findings_workspace_order',
  'idx_target_findings_search_trgm',
  'idx_snapshot_summaries_workspace_target'
]) {
  assert(initial.includes(needle), `initial migration missing ${needle}`);
}
assert(!initial.includes('node TEXT NULL'), 'target inventory items must not expose Kubernetes-only node as a generic column');
assert(!initial.includes('resource_count INTEGER'), 'target snapshot summaries must use target-neutral inventory_count');
assert(!initial.includes('namespace_count INTEGER'), 'target snapshot summaries must not expose Kubernetes-only namespace_count as a generic column');
assert(!initial.includes('node_count INTEGER'), 'target snapshot summaries must not expose Kubernetes-only node_count as a generic column');
const nullableTargetFkCount = [...initial.matchAll(/target_id TEXT NULL REFERENCES targets\(id\) ON DELETE CASCADE/g)].length;
assert(nullableTargetFkCount >= 2, 'webhook target scopes must reference targets with cascade cleanup');
for (const needle of [
  'ADD COLUMN IF NOT EXISTS tool_access_mode',
  'ADD COLUMN IF NOT EXISTS last_message_at',
  'ADD COLUMN IF NOT EXISTS expires_at',
  'ADD COLUMN IF NOT EXISTS deleted_at',
  'ADD COLUMN IF NOT EXISTS kind',
  'ADD COLUMN IF NOT EXISTS client_message_id',
  'fk_messages_session',
  'fk_runs_session',
  'fk_run_events_run'
]) {
  assert(upgrade.includes(needle), `upgrade migration missing ${needle}`);
}
for (const needle of [
  'ADD COLUMN IF NOT EXISTS source',
  'ADD COLUMN IF NOT EXISTS created_at',
  'ADD COLUMN IF NOT EXISTS updated_at',
  'CREATE TABLE IF NOT EXISTS workspace_membership_audit',
  'idx_workspace_membership_audit_workspace_created'
]) {
  assert(membershipUpgrade.includes(needle), `membership migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS workspace_audit_events',
  'workspace_audit_events_category_check',
  'workspace_audit_events_operation_check',
  "operation TEXT NOT NULL",
  "CHECK (operation IN ('read', 'write'))",
  'workspace_audit_events_actor_type_check',
  'workspace_audit_events_user_actor_check',
  'workspace_audit_events_metadata_object_check',
  'idx_workspace_audit_events_workspace_occurred',
  'idx_workspace_audit_events_workspace_type',
  'idx_workspace_audit_events_workspace_category',
  'idx_workspace_audit_events_occurred',
  'INSERT INTO workspace_audit_events'
]) {
  assert(workspaceAuditEventsUpgrade.includes(needle), `workspace audit events migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS workspace_quota_overrides',
  'ADD COLUMN IF NOT EXISTS actor_token_id',
  "actor_type IN ('user', 'system', 'admin_token')",
  'CREATE TABLE IF NOT EXISTS admin_audit_events',
  'admin_audit_events_occurred_at_idx',
  'admin_audit_events_token_idx',
  'admin_audit_events_workspace_idx',
  'admin_audit_events_action_idx'
]) {
  assert(adminApiUpgrade.includes(needle), `admin api migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS workspace_ai_settings',
  "default_provider TEXT NOT NULL CHECK (default_provider IN ('openai', 'anthropic', 'gemini'))",
  'default_model TEXT NOT NULL'
]) {
  assert(workspaceAiSettingsUpgrade.includes(needle), `workspace ai settings migration missing ${needle}`);
}
for (const needle of [
  'ADD COLUMN IF NOT EXISTS llm_provider',
  "CHECK (llm_provider IN ('openai', 'anthropic', 'gemini'))",
  'ADD COLUMN IF NOT EXISTS llm_model'
]) {
  assert(runLlmSnapshotUpgrade.includes(needle), `run llm snapshot migration missing ${needle}`);
}
for (const needle of [
  'ADD COLUMN IF NOT EXISTS reasoning_summary_mode',
  "CHECK (reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed'))",
  'ADD COLUMN IF NOT EXISTS reasoning_effort',
  "CHECK (reasoning_effort IN ('default', 'low', 'medium', 'high'))",
  'ADD COLUMN IF NOT EXISTS llm_reasoning_summary_mode',
  "CHECK (llm_reasoning_summary_mode IN ('off', 'auto', 'concise', 'detailed'))",
  'ADD COLUMN IF NOT EXISTS llm_reasoning_effort',
  "CHECK (llm_reasoning_effort IN ('default', 'low', 'medium', 'high'))"
]) {
  assert(reasoningSummariesUpgrade.includes(needle), `reasoning summaries migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS target_snapshot_history',
  'idx_target_snapshot_history_target_ts',
  'idx_target_snapshot_history_workspace_target_ts',
  'fk_target_snapshot_history_workspace_target'
]) {
  assert(snapshotHistoryUpgrade.includes(needle), `snapshot history migration missing ${needle}`);
}
assert(!snapshotHistoryUpgrade.includes('INSERT INTO'), 'fresh target snapshot history migration must not backfill old data');
for (const needle of [
  'ADD COLUMN IF NOT EXISTS namespace_include',
  'ADD COLUMN IF NOT EXISTS namespace_exclude'
]) {
  assert(namespaceScopeUpgrade.includes(needle), `namespace scope migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS user_password_credentials',
  'username TEXT UNIQUE NOT NULL',
  'password_hash TEXT NOT NULL',
  'idx_user_password_credentials_last_login'
]) {
  assert(passwordAuthUpgrade.includes(needle), `password auth migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS workspace_invitations',
  'token_hash TEXT UNIQUE NOT NULL',
  'idx_workspace_invitations_workspace_status',
  'idx_workspace_invitations_workspace_role',
  'idx_workspace_invitations_email_status'
]) {
  assert(workspaceInvitationsUpgrade.includes(needle), `workspace invitations migration missing ${needle}`);
}
assert(initial.includes('CREATE TABLE IF NOT EXISTS role_templates'), 'initial migration must create role_templates directly');
assert(initial.includes('idx_workspace_memberships_workspace_role'), 'initial migration must index workspace role filtering directly');
assert(!initial.includes('workspace_memberships_role_check'), 'workspace memberships must not use enum-style role constraints');
assert(!workspaceInvitationsUpgrade.includes('workspace_invitations_role_check'), 'workspace invitations must not use enum-style role constraints');
assert(!workspaceInvitationsUpgrade.includes("CHECK (role IN ('owner', 'admin', 'operator', 'viewer"), 'workspace invitations role must not be enum constrained');
for (const needle of [
  'CREATE TABLE IF NOT EXISTS run_tool_approvals',
  'execution_status TEXT NOT NULL DEFAULT',
  'fk_run_tool_approvals_workspace_target',
  'CREATE TABLE IF NOT EXISTS run_continuations',
  'idx_run_continuations_approval'
]) {
  assert(writeToolApprovalsUpgrade.includes(needle), `write tool approvals migration missing ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS user_federated_identities',
  'provider TEXT NOT NULL',
  'subject TEXT NOT NULL',
  'PRIMARY KEY (provider, subject)',
  'idx_user_federated_identities_user_id'
]) {
  assert(authMethodsUpgrade.includes(needle), `auth methods migration missing ${needle}`);
}
for (const needle of [
  'idx_workspaces_created_id',
  'idx_workspace_memberships_workspace_role_user',
  'idx_workspace_invitations_workspace_status_created_id',
  'idx_targets_workspace_type_status_created_id',
  'idx_sessions_workspace_target_last_message_id',
  'idx_messages_session_created_id'
]) {
  assert(pagedListIndexesUpgrade.includes(needle), `paged list index migration missing ${needle}`);
}

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
      ['kubernetes_target_settings', 'namespace_exclude']
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
           'fk_run_tool_approvals_workspace_target'
         )`
    );
    assert.equal(fkResult.rowCount, 6, 'expected session, run, and target-scope foreign keys after migrations');
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
    const roleTemplates = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'role_templates'"
    );
    assert.equal(roleTemplates.rowCount, 1, 'role template table must exist after migrations');
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
