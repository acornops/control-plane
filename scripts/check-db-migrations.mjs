import assert from 'node:assert/strict';
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

const migrationFiles = readdirSync(migrationsDir)
  .filter((entry) => entry.endsWith('.sql'))
  .sort();
assert.deepEqual(
  migrationFiles,
  ['001_initial_schema.sql'],
  'this unreleased application must keep exactly one complete greenfield schema'
);

const baseline = read('migrations/control-plane/001_initial_schema.sql');
const migrations = migrationFiles.map((filename) => read(`migrations/control-plane/${filename}`));
for (const forbidden of [
  /\bADD COLUMN IF NOT EXISTS\b/i,
  /\bDROP (?:COLUMN|CONSTRAINT|TABLE)\b/i,
  /^\s*(?:UPDATE|DELETE)\s+[a-z_]/im,
  /WORKFLOW_V\d+_DATABASE_RESET_REQUIRED/,
  /seed_workspace_.+_v\d+/,
  /system_template_version/,
  /legacy_shared/,
  /mcp_server::/
]) {
  assert(!forbidden.test(baseline), `greenfield baseline contains historical operation ${forbidden}`);
}
for (const required of [
  'admin_actor_issuer',
  'admin_actor_subject',
  'admin_actor_role',
  'admin_session_id_hash',
  'authentication_time',
  'lifecycle_status',
  'suspended_at',
  'admin_audit_events_append_only',
  'REVOKE UPDATE, DELETE ON admin_audit_events FROM PUBLIC'
]) {
  assert(baseline.includes(required), `greenfield baseline must include ${required}`);
}

const dbSource = read('src/infra/db.ts');
assert(!dbSource.includes('SCHEMA_SQL'), 'startup must not carry boot-time schema SQL');
assert(!/CREATE TABLE IF NOT EXISTS \w+/i.test(dbSource), 'startup must not create application tables');
assert(!/ALTER TABLE \w+/i.test(dbSource), 'startup must not alter application tables');
assert(dbSource.includes('assertDatabaseMigrationsCurrent'), 'startup must verify the baseline is current');

const packageJson = JSON.parse(read('package.json'));
for (const command of ['db:migrate', 'db:status', 'db:check']) {
  assert(packageJson.scripts[command], `package must expose ${command}`);
}
assert(packageJson.scripts.validate.includes('migrations:check'), 'validate must include migration checks');

for (const content of [read('docker-compose.yml'), read('docker-compose.override.yml')]) {
  assert(content.includes('control-plane-init:'), 'compose must define control-plane-init');
  assert(
    content.includes('control-plane-db') || content.includes('db:migrate'),
    'compose migration job must run the control-plane migration CLI'
  );
}

if (existsSync(deploymentRoot)) {
  for (const content of [
    readDeploymentFile('compose/local/compose.source.yaml'),
    readDeploymentFile('compose/vm-prod/compose.yaml')
  ]) {
    assert(content.includes('control-plane-init:'), 'deployment compose must define control-plane-init');
    assert(
      content.includes('control-plane-db') || content.includes('db:migrate'),
      'deployment migration job must run the control-plane migration CLI'
    );
  }
  assert(
    readDeploymentFile('scripts/local-up.sh').includes('run --rm --build control-plane-init'),
    'local-up must run control-plane migrations before startup'
  );
  assert(
    readDeploymentFile('scripts/prod-up.sh').includes('run --rm control-plane-init'),
    'prod-up must run control-plane migrations before startup'
  );
}

const expectedTables = [
  'users',
  'workspaces',
  'workspace_memberships',
  'targets',
  'sessions',
  'messages',
  'runs',
  'run_events',
  'run_tool_approvals',
  'target_auto_triage_settings',
  'target_auto_triage_jobs',
  'agent_definitions',
  'agent_skills',
  'agent_skill_files',
  'workflow_definitions',
  'workflow_executions',
  'workflow_runs',
  'workflow_run_events',
  'workflow_run_approvals',
  'workflow_run_continuations',
  'workflow_schedules',
  'workflow_webhooks',
  'workflow_webhook_events',
  'workflow_webhook_deliveries',
  'generated_documents',
  'automation_template_installations',
  'capability_routing_mappings',
  'target_skills',
  'target_skill_files',
  'workspace_defaults',
  'workspace_default_skill_files',
  'workspace_initial_defaults',
  'workspace_initial_default_skill_files',
  'webhook_outbox_events',
  'webhook_delivery_jobs'
];

const expectedColumns = [
  ['admin_audit_events', 'admin_actor_issuer'],
  ['admin_audit_events', 'admin_actor_subject'],
  ['admin_audit_events', 'admin_actor_email'],
  ['admin_audit_events', 'admin_actor_display_name'],
  ['admin_audit_events', 'admin_actor_role'],
  ['admin_audit_events', 'admin_session_id_hash'],
  ['admin_audit_events', 'authentication_time'],
  ['workspaces', 'lifecycle_status'],
  ['workspaces', 'suspended_at'],
  ['runs', 'assistant_references'],
  ['runs', 'tool_access_mode'],
  ['runs', 'request_actor_type'],
  ['runs', 'confirmation_required_for_write_override'],
  ['runs', 'conversation_kind'],
  ['runs', 'agent_id'],
  ['runs', 'agent_snapshot'],
  ['runs', 'compiled_access_scope'],
  ['sessions', 'origin'],
  ['sessions', 'linked_issue_id'],
  ['sessions', 'linked_issue_lifecycle_version'],
  ['sessions', 'auto_triage_write_mode'],
  ['sessions', 'auto_triage_effective_tool_mode'],
  ['sessions', 'auto_triage_confirmation_required'],
  ['sessions', 'conversation_kind'],
  ['sessions', 'agent_id'],
  ['sessions', 'preferred_access_mode'],
  ['sessions', 'launched_at'],
  ['messages', 'created_by'],
  ['target_auto_triage_settings', 'revision'],
  ['target_auto_triage_settings', 'namespace_include'],
  ['target_auto_triage_settings', 'namespace_exclude'],
  ['target_auto_triage_settings', 'include_cluster_scoped_issues'],
  ['target_auto_triage_jobs', 'issue_lifecycle_version'],
  ['target_auto_triage_jobs', 'settings_revision'],
  ['target_auto_triage_jobs', 'retry_generation'],
  ['target_auto_triage_jobs', 'lease_owner'],
  ['target_auto_triage_jobs', 'lease_expires_at'],
  ['workflow_executions', 'resource_bindings'],
  ['workflow_runs', 'resource_bindings'],
  ['agent_definitions', 'mcp_installations'],
  ['agent_definitions', 'semantic_capability_ids'],
  ['agent_definitions', 'avatar_emoji'],
  ['workflow_definitions', 'agent_ids'],
  ['workflow_runs', 'execution_id'],
  ['workflow_runs', 'executor_role'],
  ['workflow_runs', 'parent_run_id'],
  ['workflow_runs', 'delegation_call_id'],
  ['workflow_runs', 'delegation_capability_id'],
  ['workflow_runs', 'delegation_required'],
  ['workflow_runs', 'executor_snapshot'],
  ['workflow_sessions', 'workflow_snapshot'],
  ['workflow_sessions', 'launched_at'],
  ['workflow_sessions', 'launch_resource_inputs'],
  ['workflow_executions', 'client_request_fingerprint'],
  ['workflow_executions', 'origin_snapshot'],
  ['workflow_executions', 'source_type'],
  ['workflow_executions', 'source_id'],
  ['workflow_schedules', 'last_execution_id'],
  ['workflow_schedules', 'last_run_id'],
  ['workflow_webhooks', 'last_received_at'],
  ['workflow_webhooks', 'last_execution_id'],
  ['workflow_webhooks', 'last_run_id'],
  ['workflow_webhook_events', 'webhook_id'],
  ['workflow_webhook_deliveries', 'webhook_id'],
  ['target_issues', 'lifecycle_version'],
  ['webhook_history', 'attempt_number'],
  ['webhook_history', 'will_retry'],
  ['webhook_history', 'next_attempt_at'],
  ['webhook_history', 'terminal_reason'],
  ['workspace_defaults', 'available_in'],
  ['workspace_defaults', 'enabled'],
  ['workspace_initial_defaults', 'available_in']
];

const expectedConstraints = [
  'ck_workspaces_lifecycle_status',
  'fk_messages_session',
  'fk_runs_session',
  'fk_run_events_run',
  'fk_sessions_workspace_target',
  'fk_runs_workspace_target',
  'fk_run_tool_approvals_workspace_target',
  'fk_chat_activity_events_workspace_target',
  'sessions_origin_check',
  'sessions_auto_triage_write_mode_check',
  'sessions_auto_triage_tool_mode_check',
  'sessions_conversation_kind_check',
  'sessions_conversation_binding_check',
  'sessions_preferred_access_mode_check',
  'sessions_workspace_agent_fkey',
  'runs_conversation_kind_check',
  'runs_conversation_binding_check',
  'runs_workspace_agent_fkey',
  'runs_request_actor_type_check',
  'runs_request_actor_provenance_check',
  'target_auto_triage_settings_pkey',
  'target_auto_triage_settings_namespace_include_check',
  'target_auto_triage_settings_namespace_exclude_check',
  'fk_target_auto_triage_settings_workspace_target',
  'target_auto_triage_jobs_issue_lifecycle_key',
  'fk_target_auto_triage_jobs_workspace_target',
  'target_auto_triage_jobs_issue_fkey',
  'target_auto_triage_jobs_session_id_fkey',
  'target_auto_triage_jobs_run_id_fkey',
  'workflow_definitions_agent_ids_nonempty',
  'workflow_runs_executor_role_check',
  'workflow_runs_executor_shape_check',
  'workflow_runs_executor_snapshot_check',
  'workflow_run_approvals_run_id_tool_call_id_key',
  'workflow_sessions_launch_resource_inputs_check',
  'workflow_executions_client_request_fingerprint_check',
  'workflow_webhooks_principal_check',
  'workflow_webhook_events_workspace_webhook_occurrence_key',
  'workflow_webhook_events_webhook_id_fkey',
  'workflow_webhook_deliveries_webhook_id_fkey',
  'runs_assistant_references_array',
  'webhook_delivery_jobs_status_check',
  'webhook_delivery_jobs_event_id_fkey',
  'workspace_defaults_available_in_check',
  'workspace_initial_defaults_available_in_check'
];

async function runSqlChecks(databaseUrl) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = `cp_baseline_check_${Date.now()}_${process.pid}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const migration of migrations) await client.query(migration);

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    );
    const tableNames = new Set(tables.rows.map((row) => row.table_name));
    for (const table of expectedTables) assert(tableNames.has(table), `${table} must exist in the final baseline`);

    for (const [table, column] of expectedColumns) {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      assert.equal(result.rowCount, 1, `${table}.${column} must exist in the final baseline`);
    }
    for (const [table, column] of [
      ['sessions', 'target_id'],
      ['runs', 'target_id'],
      ['run_tool_approvals', 'target_id']
    ]) {
      const result = await client.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      assert.equal(result.rows[0]?.is_nullable, 'YES', `${table}.${column} must allow Agent-chat records`);
    }

    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE connamespace = current_schema()::regnamespace`
    );
    const constraintMap = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    for (const constraint of expectedConstraints) {
      assert(constraintMap.has(constraint), `${constraint} must exist in the final baseline`);
    }
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const indexName of [
      'idx_sessions_auto_triage_issue_lifecycle',
      'idx_target_auto_triage_jobs_due',
      'idx_target_auto_triage_jobs_target_status',
      'idx_target_auto_triage_jobs_workspace_issue',
      'workflow_executions_workspace_created_idx',
      'workflow_executions_source_idx',
      'workflow_webhooks_workspace_idx',
      'workflow_webhook_deliveries_claim_idx',
      'workspace_defaults_available_in_idx',
      'workspace_initial_defaults_workspace_kind_idx',
      'sessions_agent_conversations_idx'
    ]) {
      assert(indexNames.has(indexName), `${indexName} must exist in the final baseline`);
    }
    for (const [table, column] of [
      ['agent_definitions', 'source'],
      ['agent_definitions', 'system_template_version'],
      ['agent_definitions', 'kind'],
      ['agent_definitions', 'system_role'],
      ['agent_definitions', 'delegate_agent_ids'],
      ['workflow_definitions', 'orchestrator_agent_id'],
      ['workflow_definitions', 'entry_agent_id'],
      ['workflow_definitions', 'delegation_policy'],
      ['workflow_definitions', 'steps'],
      ['workflow_definitions', 'inputs'],
      ['workflow_executions', 'current_step_index'],
      ['workflow_schedules', 'control_message'],
      ['workflow_runs', 'workflow_run_id'],
      ['workflow_runs', 'agent_snapshot'],
      ['workflow_sessions', 'conversation_origin'],
      ['workflow_sessions', 'agent_id'],
      ['workflow_sessions', 'access_mode'],
      ['workflow_sessions', 'agent_chat_read_scope'],
      ['workflow_sessions', 'agent_chat_capability_ceiling'],
      ['capability_routing_mappings', 'invocation_scopes'],
      ['sessions', 'selected_agent_id'],
      ['agent_definitions', 'target_id'],
      ['agent_definitions', 'target_ids'],
      ['agent_definitions', 'target_type'],
      ['agent_definitions', 'target_scope'],
      ['agent_definitions', 'target_binding'],
      ['agent_definitions', 'workflow_ids'],
      ['runs', 'agent_version'],
      ['agent_definitions', 'version'],
      ['capability_routing_mappings', 'version'],
      ['capability_routing_mappings', 'agent_version'],
      ['capability_routing_mappings', 'target_tool_refs'],
      ['workflow_definitions', 'version'],
      ['workflow_definitions', 'target_id'],
      ['workflow_definitions', 'target_ids'],
      ['workflow_definitions', 'target_type'],
      ['workflow_definitions', 'target_scope'],
      ['workflow_definitions', 'target_binding'],
      ['workflow_executions', 'workflow_version'],
      ['workflow_definitions', 'enabled_mcp_servers'],
      ['workflow_definitions', 'enabled_skills'],
      ['workflow_runs', 'agent_version'],
      ['workflow_schedules', 'workflow_version'],
      ['workflow_schedules', 'inputs'],
      ['workflow_schedules', 'parameter_signature'],
      ['workflow_sessions', 'workflow_version'],
      ['workflow_webhooks', 'workflow_version'],
      ['workflow_webhooks', 'parameter_signature']
    ]) {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      assert.equal(result.rowCount, 0, `${table}.${column} must not survive the greenfield baseline`);
    }

    for (const table of [
      'agent_triggers',
      'agent_activity',
      'agent_run_events',
      'agent_versions',
      'agent_targets',
      'target_agents',
      'workflow_mcp_servers',
      'workflow_targets',
      'target_workflows',
      'workflow_reports',
      'workflow_delegations',
      'workflow_approvals',
      'automation_run_approvals',
      'automation_run_continuations',
      'workflow_event_triggers',
      'automation_trigger_events',
      'automation_trigger_deliveries'
    ]) {
      assert.equal(tableNames.has(table), false, `${table} must not survive the greenfield baseline`);
    }

    const functions = await client.query(
      `SELECT proname FROM pg_proc WHERE pronamespace = current_schema()::regnamespace`
    );
    assert.deepEqual(
      functions.rows.map(({ proname }) => proname).sort(),
      ['prevent_admin_audit_event_mutation'],
      'only the append-only admin audit trigger function may survive'
    );

    const adminAuditTriggers = await client.query(
      `SELECT tgname
       FROM pg_trigger
       WHERE tgrelid = 'admin_audit_events'::regclass
         AND NOT tgisinternal`
    );
    assert.deepEqual(
      adminAuditTriggers.rows.map(({ tgname }) => tgname).sort(),
      ['admin_audit_events_append_only'],
      'the append-only admin audit trigger must be installed'
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
}

const integrationDatabaseUrl = process.env.CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL;
if (integrationDatabaseUrl) {
  await runSqlChecks(integrationDatabaseUrl);
  console.log('Control-plane greenfield baseline static and SQL checks passed.');
} else {
  console.log(
    'Control-plane greenfield baseline static checks passed. Set CONTROL_PLANE_MIGRATION_TEST_DATABASE_URL to run SQL introspection.'
  );
}
