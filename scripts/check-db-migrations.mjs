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
  'the greenfield control-plane must have exactly one numbered SQL baseline'
);

const baseline = read('migrations/control-plane/001_initial_schema.sql');
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
  'agent_definitions',
  'agent_skills',
  'agent_skill_files',
  'agent_triggers',
  'workflow_definitions',
  'workflow_executions',
  'workflow_runs',
  'workflow_schedules',
  'workflow_reports',
  'automation_template_installations',
  'capability_routing_mappings',
  'workflow_delegations',
  'target_skills',
  'target_skill_files'
];

const expectedColumns = [
  ['runs', 'assistant_references'],
  ['runs', 'tool_access_mode'],
  ['workflow_executions', 'resource_bindings'],
  ['workflow_runs', 'resource_bindings'],
  ['workflow_definitions', 'resource_requirements'],
  ['agent_definitions', 'mcp_installations'],
  ['agent_definitions', 'semantic_capability_ids'],
  ['agent_definitions', 'system_role'],
  ['workflow_definitions', 'entry_agent_id'],
  ['workflow_definitions', 'agent_ids'],
  ['workflow_sessions', 'workflow_snapshot'],
  ['capability_routing_mappings', 'invocation_scopes']
];

const expectedConstraints = [
  'fk_messages_session',
  'fk_runs_session',
  'fk_run_events_run',
  'fk_sessions_workspace_target',
  'fk_runs_workspace_target',
  'fk_run_tool_approvals_workspace_target',
  'fk_chat_activity_events_workspace_target',
  'capability_routing_mappings_invocation_scopes_check',
  'workflow_definitions_agent_ids_nonempty',
  'runs_assistant_references_array'
];

async function runSqlChecks(databaseUrl) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = `cp_baseline_check_${Date.now()}_${process.pid}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(baseline);

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

    const constraints = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE connamespace = current_schema()::regnamespace`
    );
    const constraintMap = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    for (const constraint of expectedConstraints) {
      assert(constraintMap.has(constraint), `${constraint} must exist in the final baseline`);
    }
    assert(
      constraintMap.get('capability_routing_mappings_invocation_scopes_check').includes('target_chat'),
      'the invocation-scope constraint must allow target_chat'
    );

    for (const [table, column] of [
      ['agent_definitions', 'source'],
      ['agent_definitions', 'system_template_version'],
      ['workflow_definitions', 'orchestrator_agent_id'],
      ['workflow_definitions', 'steps'],
      ['workflow_executions', 'current_step_index'],
      ['sessions', 'selected_agent_id'],
      ['runs', 'agent_id']
    ]) {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      assert.equal(result.rowCount, 0, `${table}.${column} must not survive the greenfield baseline`);
    }

    const functions = await client.query(
      `SELECT proname FROM pg_proc WHERE pronamespace = current_schema()::regnamespace`
    );
    assert.equal(functions.rowCount, 0, 'pre-release seeding and upgrade functions must not survive');
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
