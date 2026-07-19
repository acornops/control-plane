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
const releasedChecksums = JSON.parse(read('migrations/control-plane/released-checksums.json'));
assert.equal(releasedChecksums.schemaVersion, 1, 'released migration checksum manifest schema');
assert.equal(releasedChecksums.algorithm, 'sha256', 'released migration checksum algorithm');
const releasedFiles = Object.keys(releasedChecksums.migrations);
assert.deepEqual(releasedFiles, [...releasedFiles].sort(), 'released migration checksum entries must be append ordered');
const highestReleasedVersion = Number.parseInt(releasedFiles.at(-1).slice(0, 3), 10);
for (const file of files) {
  assert(/^\d{3,}_[a-z0-9_]+\.sql$/.test(file), `invalid migration filename ${file}`);
  const checksum = checksumSql(read(`migrations/control-plane/${file}`));
  if (releasedChecksums.migrations[file]) {
    assert.equal(checksum, releasedChecksums.migrations[file], `released migration ${file} is immutable`);
  } else {
    assert(Number.parseInt(file.slice(0, 3), 10) > highestReleasedVersion, `only appended migrations may follow the released manifest: ${file}`);
  }
}
for (const file of releasedFiles) assert(files.includes(file), `released migration is missing: ${file}`);

const initial = read('migrations/control-plane/001_initial_schema.sql');
const agentsWorkflows = read('migrations/control-plane/002_agents_workflows.sql');
const workflowOptionCatalogs = read('migrations/control-plane/003_workflow_option_catalogs.sql');
const durableAutomationRuntime = read('migrations/control-plane/004_durable_automation_runtime.sql');
const automationApprovals = read('migrations/control-plane/005_automation_approvals.sql');
const agentActivityStatuses = read('migrations/control-plane/006_agent_activity_statuses.sql');
const systemSkillSeeding = read('migrations/control-plane/007_system_skill_seeding.sql');
const clusterTriageBuiltInTools = read('migrations/control-plane/008_cluster_triage_builtin_tools.sql');
const workflowPromptReferences = read('migrations/control-plane/009_workflow_prompt_references.sql');
const toolResultArtifacts = read('migrations/control-plane/010_tool_result_artifacts.sql');
const chatRuntimeSelection = read('migrations/control-plane/011_chat_runtime_selection.sql');
const systemAutomationFoundations = read('migrations/control-plane/012_system_automation_foundations.sql');
const agentOwnedCapabilities = read('migrations/control-plane/013_agent_owned_capabilities.sql');
const workflowAgentV2 = read('migrations/control-plane/014_workflow_agent_v2.sql');
const workflowScheduleUserPrincipals = read('migrations/control-plane/015_workflow_schedule_user_principals.sql');
const automaticWorkflowCoordination = read('migrations/control-plane/017_automatic_workflow_coordination.sql');
const workflowCapabilityInheritance = read('migrations/control-plane/018_workflow_capability_inheritance_native_tools.sql');
const targetDiagnosticsScope = read('migrations/control-plane/019_target_diagnostics_scope.sql');
const approvalReceipts = read('migrations/control-plane/020_approval_receipts.sql');
const targetChatReportArtifacts = read('migrations/control-plane/021_target_chat_report_artifacts.sql');
const targetChatInvocationScope = read('migrations/control-plane/022_target_chat_invocation_scope.sql');
assert(targetDiagnosticsScope.includes('target_tool_refs'));
assert(workflowCapabilityInheritance.includes('invocation_scopes'));
assert(workflowCapabilityInheritance.includes('"restrict"'));
assert(workflowCapabilityInheritance.includes('workflow_reports_run_tool_call_unique'));
assert(targetChatReportArtifacts.includes('target_run_id TEXT NULL REFERENCES runs(id) ON DELETE CASCADE'));
assert(targetChatReportArtifacts.includes('workflow_reports_exactly_one_run_scope_check'));
assert(targetChatReportArtifacts.includes('workflow_reports_target_run_tool_call_unique'));
for (const needle of [
  'DROP CONSTRAINT IF EXISTS capability_routing_mappings_invocation_scopes_check',
  'ADD CONSTRAINT capability_routing_mappings_invocation_scopes_check',
  `invocation_scopes <@ '["agent","workflow","target_chat"]'::jsonb`,
  'VALIDATE CONSTRAINT capability_routing_mappings_invocation_scopes_check'
]) {
  assert(targetChatInvocationScope.includes(needle), `target-chat invocation scope migration must include ${needle}`);
}
assert(toolResultArtifacts.includes('CREATE TABLE IF NOT EXISTS run_tool_result_artifacts'));
assert(toolResultArtifacts.includes('ON DELETE CASCADE'));
assert(chatRuntimeSelection.includes('ON runs (session_id, requested_at DESC, id DESC)'));
for (const forbidden of ['INSERT INTO agent_definitions', 'INSERT INTO workflow_definitions', 'http://', 'agent-workflow-orchestrator']) {
  assert(!systemAutomationFoundations.includes(forbidden), `unreleased catalog foundation must not contain ${forbidden}`);
}
for (const needle of [
  'mcp_tools JSONB',
  'mcp_installations JSONB',
  'skill_installations JSONB',
  'permission_mode TEXT',
  'delegate_agent_ids JSONB',
  'CREATE TABLE IF NOT EXISTS agent_skills',
  'CREATE TABLE IF NOT EXISTS service_identities',
  "source_type IN ('manual', 'git', 'template')"
]) {
  assert(agentOwnedCapabilities.includes(needle), `agent-owned capability migration must preserve ${needle}`);
}
for (const needle of [
  'CREATE TABLE IF NOT EXISTS automation_template_installations',
  'CREATE TABLE IF NOT EXISTS capability_routing_mappings',
  'CREATE TABLE IF NOT EXISTS workflow_delegations',
  'semantic_capability_ids JSONB',
  "kind IN ('manager', 'specialist')",
  'agent_definitions_manager_coordination_only',
  'DROP COLUMN IF EXISTS selected_agent_id'
]) {
  assert(workflowAgentV2.includes(needle), `Workflow Agent V2 migration must include ${needle}`);
}
assert(workflowAgentV2.includes('WORKFLOW_V2_DATABASE_RESET_REQUIRED'), 'Workflow Agent V2 must fail closed on incompatible data');
assert(!workflowAgentV2.includes('DELETE FROM'), 'Workflow Agent V2 must never delete existing data');
assert(!workflowAgentV2.includes("SET status='cancelled'"), 'Workflow Agent V2 must never cancel active runs automatically');
for (const needle of ['server_id TEXT', 'server_tool_name TEXT', 'requested_tool_alias TEXT', 'arguments_digest TEXT']) {
  assert(approvalReceipts.includes(needle), `approval receipt migration must persist ${needle}`);
}
for (const needle of [
  "principal->>'type' = 'user'",
  "principal = jsonb_build_object('type', 'user', 'id', schedule.created_by->>'userId')",
  "creator is no longer an authorized workspace member"
]) {
  assert(workflowScheduleUserPrincipals.includes(needle), `user-principal schedule migration must include ${needle}`);
}
for (const needle of [
  'system_role TEXT',
  'agent_definitions_workspace_system_role_unique',
  'agent_ids JSONB',
  'workflow_definitions_agent_ids_nonempty',
  "'workflow_coordinator'",
  'WORKFLOW_AGENT_SELECTION_REQUIRED',
  "'maxConcurrentChildren', 4",
  "'maxChildren', 8"
]) {
  assert(automaticWorkflowCoordination.includes(needle), `automatic workflow coordination migration must include ${needle}`);
}
for (const forbidden of [
  'TRUNCATE TABLE workflow_mcp_servers',
  'DELETE FROM target_skill_files',
  'DELETE FROM target_skills',
  'DELETE FROM workspace_skills',
  "SET mcp_servers = '[]'::jsonb",
  "tools = '[]'::jsonb",
  "skills = '[]'::jsonb"
]) {
  assert(!agentOwnedCapabilities.includes(forbidden), `capability migration must not contain ${forbidden}`);
}
for (const table of [
  'agent_definitions',
  'agent_triggers',
  'agent_versions',
  'agent_activity',
  'workflow_definitions',
  'workflow_mcp_servers',
  'workflow_schedules',
  'workflow_sessions',
  'workflow_messages',
  'workflow_runs',
  'workflow_approvals'
]) {
  assert(agentsWorkflows.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `agents/workflows migration must create ${table}`);
}
for (const table of ['workspace_skills']) {
  assert(workflowOptionCatalogs.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `workflow option catalog migration must create ${table}`);
}
for (const needle of [
  'workspace_skills_name_unique',
  'workspace_skills_workspace_enabled_valid_name_idx'
]) {
  assert(workflowOptionCatalogs.includes(needle), `workflow option catalog migration must preserve ${needle}`);
}
for (const needle of [
  'lease_owner TEXT NULL',
  'lease_expires_at TIMESTAMPTZ NULL',
  "CHECK (jsonb_typeof(compiled_access_scope) = 'object')",
  'ON DELETE RESTRICT',
  'workflow_schedules_due_idx'
]) {
  assert(agentsWorkflows.includes(needle), `agents/workflows migration must preserve ${needle}`);
}
for (const table of [
  'workflow_executions',
  'workflow_run_events',
  'agent_run_events',
  'automation_dispatch_outbox',
  'automation_trigger_events',
  'automation_trigger_deliveries',
  'workflow_reports'
]) {
  assert(durableAutomationRuntime.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `durable automation migration must create ${table}`);
}
for (const needle of [
  'workflow_runs_execution_step_attempt_unique',
  'automation_dispatch_outbox_claim_idx',
  'workflow_approvals_expiry_idx'
]) {
  assert(durableAutomationRuntime.includes(needle), `durable automation migration must preserve ${needle}`);
}
for (const table of ['automation_run_approvals', 'automation_run_continuations']) {
  assert(automationApprovals.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `automation approval migration must create ${table}`);
}
for (const needle of [
  'automation_run_approvals_expiry_idx',
  "'waiting_for_approval'",
  "'needs_review'"
]) {
  assert(automationApprovals.includes(needle), `automation approval migration must preserve ${needle}`);
}
for (const needle of ['agent_definitions_last_status_check', "'waiting_for_approval'", "'needs_review'"]) {
  assert(agentActivityStatuses.includes(needle), `agent activity status migration must preserve ${needle}`);
}
// Released migrations may contain historical runtime fixtures. Their checksums are
// frozen above; removal happens only through the explicit greenfield reset cutover.
for (const legacyIdentity of [
  'system_orchestrator',
  'specialist_agent',
  'agent-workflow-orchestrator',
  'agent-cluster-triage',
  'agent-release-coordinator',
  'agent-incident-reporter'
]) {
  for (const file of files) {
    if (Number.parseInt(file.slice(0, 3), 10) < 11 || file === '014_workflow_agent_v2.sql') continue;
    const sql = read(`migrations/control-plane/${file}`);
    assert(!sql.includes(legacyIdentity), `${legacyIdentity} may appear only in the one-time Workflow Agent V2 cleanup migration`);
  }
}
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
  'target_inventory_items',
  'target_findings',
  'target_snapshot_summaries',
  'target_issues',
  'target_issue_observations',
  'target_metric_history',
  'target_tool_overrides',
  'target_tool_settings',
  'target_skills',
  'target_skill_files',
  'sessions',
  'messages',
  'runs',
  'run_events',
  'run_skill_catalog_snapshots',
  'skill_snapshot_blobs',
  'run_skill_snapshots',
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
  "CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high'))",
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
  'fk_target_issues_workspace_target',
  'fk_target_issue_observations_workspace_target',
  'fk_target_metric_history_workspace_target',
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
  "severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info'))",
  'CREATE TABLE IF NOT EXISTS target_issues',
  'CREATE TABLE IF NOT EXISTS target_issue_observations',
  'idx_target_issues_workspace_order',
  'idx_target_issue_observations_issue_ts',
  'CREATE TABLE IF NOT EXISTS target_metric_history',
  'metrics JSONB NOT NULL DEFAULT',
  'PRIMARY KEY (target_id, sample_ts)',
  'idx_target_metric_history_target_ts',
  'idx_target_metric_history_workspace_target_ts',
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
const chatActivityTable = initial.slice(
  initial.indexOf('CREATE TABLE IF NOT EXISTS chat_activity_events'),
  initial.indexOf('CREATE TABLE IF NOT EXISTS webhook_subscriptions')
);
for (const childResource of ['sessions', 'runs', 'messages', 'run_tool_approvals']) {
  assert(
    !new RegExp(`REFERENCES\\s+${childResource}\\b`, 'i').test(chatActivityTable),
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
assert(!initial.includes('CREATE TABLE IF NOT EXISTS target_snapshot_history'), 'squashed baseline must not create target snapshot history');
assert(!initial.includes('fk_target_snapshot_history_workspace_target'), 'squashed baseline must not keep target snapshot history foreign keys');
assert(!initial.includes('idx_target_snapshot_history_target_ts'), 'squashed baseline must not keep target snapshot history indexes');

const targetSkills = initial;
for (const table of ['target_skills', 'target_skill_files']) {
  assert(targetSkills.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `target skills migration must create ${table}`);
}
for (const needle of [
  "source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'git_import'))",
  "source_provider TEXT NULL CHECK (source_provider IS NULL OR source_provider IN ('github', 'gitlab'))",
  "source_api_base_url TEXT NULL",
  "validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid'))",
  "sync_status TEXT NOT NULL CHECK (sync_status IN ('not_applicable', 'current', 'modified'))",
  "file_count INTEGER NOT NULL CHECK (file_count >= 1 AND file_count <= 16)",
  "total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 131072)",
  'target_skills_target_scope_unique',
  'target_skills_source_metadata_check',
  "size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 32768)",
  'target_skill_files_path_check',
  "path LIKE '%.md'",
  "path NOT LIKE '/%'",
  "path NOT LIKE '%/../%'",
  "path NOT LIKE '%/./%'",
  'idx_target_skills_target_updated',
  'idx_target_skills_target_enabled_valid',
  'idx_target_skill_files_skill_path'
]) {
  assert(targetSkills.includes(needle), `target skills migration missing ${needle}`);
}
for (const needle of [
  "source_type = 'git_import'",
  'source_provider IS NOT NULL',
  'source_repo_url IS NOT NULL',
  'source_ref IS NOT NULL',
  'source_api_base_url IS NULL',
  "sync_status IN ('current', 'modified')"
]) {
  assert(targetSkills.includes(needle), `target skills migration missing ${needle}`);
}
assert(
  !targetSkills.includes('source_commit_sha IS NOT NULL'),
  'target skills migration must allow Git imports without source_commit_sha'
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
      ['agent_definitions', 'mcp_tools'],
      ['agent_definitions', 'mcp_installations'],
      ['agent_definitions', 'permission_mode'],
      ['agent_definitions', 'delegate_agent_ids'],
      ['agent_definitions', 'skill_installations'],
      ['agent_definitions', 'origin'],
      ['agent_definitions', 'review_state'],
      ['agent_definitions', 'semantic_capability_ids'],
      ['agent_definitions', 'system_role'],
      ['capability_routing_mappings', 'invocation_scopes'],
      ['workflow_definitions', 'entry_agent_id'],
      ['workflow_definitions', 'agent_ids'],
      ['workflow_definitions', 'capability_policy'],
      ['workflow_sessions', 'workflow_snapshot'],
      ['agent_triggers', 'principal'],
      ['workflow_schedules', 'principal'],
      ['chat_activity_events', 'payload'],
      ['account_audit_events', 'metadata']
    ]) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [table, column]
      );
      assert.equal(result.rowCount, 1, `${table}.${column} must exist after migrations`);
    }
    for (const [table, column] of [
      ['agent_definitions', 'source'],
      ['agent_definitions', 'system_template_version'],
      ['workflow_definitions', 'source'],
      ['workflow_definitions', 'orchestrator_agent_id'],
      ['workflow_definitions', 'steps'],
      ['workflow_executions', 'current_step_index'],
      ['workflow_run_steps', 'workflow_step_id'],
      ['workflow_run_steps', 'step_index'],
      ['workflow_run_steps', 'step_snapshot'],
      ['workflow_run_steps', 'step_scope'],
      ['sessions', 'selected_agent_id'],
      ['runs', 'agent_id']
    ]) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [table, column]
      );
      assert.equal(result.rowCount, 0, `${table}.${column} must be removed by the Workflow Agent V2 migration`);
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
    const metricHistory = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'target_metric_history'"
    );
    assert.equal(metricHistory.rowCount, 1, 'target metric history table must exist after migrations');
    const targetIssues = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'target_issues'"
    );
    assert.equal(targetIssues.rowCount, 1, 'target issues table must exist after migrations');
    const targetIssueObservations = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'target_issue_observations'"
    );
    assert.equal(targetIssueObservations.rowCount, 1, 'target issue observations table must exist after migrations');
    const snapshotHistory = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'target_snapshot_history'"
    );
    assert.equal(snapshotHistory.rowCount, 0, 'target snapshot history table must be removed after migrations');
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
    for (const table of ['system_agent_workspace_configuration', 'system_workflow_workspace_configuration']) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      assert.equal(result.rowCount, 0, `${table} must be removed after Workflow Agent V2 migration`);
    }
    for (const table of [
      'agent_skills',
      'agent_skill_files',
      'service_identities',
      'automation_template_installations',
      'capability_routing_mappings',
      'workflow_delegations'
    ]) {
      const result = await client.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      assert.equal(result.rowCount, 1, `${table} must exist after migrations`);
    }
    const invocationScopeConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace
         AND conrelid = 'capability_routing_mappings'::regclass
         AND conname = 'capability_routing_mappings_invocation_scopes_check'`
    );
    assert.equal(invocationScopeConstraint.rowCount, 1, 'invocation scope constraint must exist after migrations');
    assert(
      invocationScopeConstraint.rows[0].definition.includes('target_chat'),
      'invocation scope constraint must allow target_chat after migrations'
    );
  }

  async function assertGreenfieldResetRequired(client) {
    const workflowV2Index = sqlFiles.findIndex(({ file }) => file === '014_workflow_agent_v2.sql');
    for (const { sql } of sqlFiles.slice(0, workflowV2Index)) await client.query(sql);

    await client.query(
      `INSERT INTO users (id,email,display_name)
       VALUES ('v1-reset-user','v1-reset@example.test','V1 Reset User')`
    );
    await client.query(
      `INSERT INTO workspaces (id,name,created_by)
       VALUES ('v1-reset-workspace','V1 Reset Workspace','v1-reset-user')`
    );
    await client.query(
      `INSERT INTO agent_definitions (
         workspace_id,id,name,description,instructions,status,source,kind,
         provider_type,version,owner_user_id,created_by,mcp_servers,tools,skills,
         context_grants,target_scope,approval_policy,trust_policy
       ) VALUES (
         'v1-reset-workspace','v1-reset-agent','V1 Agent','Legacy Agent','Legacy instructions',
         'draft','user','specialist_agent','internal',1,'v1-reset-user','v1-reset-user',
         '[]','[]','[]','[]','{}','{}','{}'
       )`
    );
    await client.query(
      `INSERT INTO workflow_definitions (
         workspace_id,id,version,source,name,description,status,category,
         orchestrator_agent_id,policy,steps,created_by
       ) VALUES (
         'v1-reset-workspace','v1-reset-workflow',1,'user','V1 Workflow','Must survive failed cutover',
         'draft','operations','v1-reset-agent','{}','[]','v1-reset-user'
       )`
    );

    await assert.rejects(
      client.query(sqlFiles[workflowV2Index].sql),
      (error) => error.code === 'P0001' && error.message.includes('WORKFLOW_V2_DATABASE_RESET_REQUIRED')
    );
    const preserved = await client.query(
      `SELECT source,kind FROM agent_definitions
       WHERE workspace_id='v1-reset-workspace' AND id='v1-reset-agent'`
    );
    assert.deepEqual(preserved.rows[0], { source: 'user', kind: 'specialist_agent' });
    assert.equal(
      Number((await client.query(
        "SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id='v1-reset-workspace'"
      )).rows[0].count),
      1,
      'Workflow V1 data must remain unchanged after reset-required failure'
    );
  }

  try {
    await withSchema('empty', async (client) => {
      for (const { sql } of sqlFiles) {
        await client.query(sql);
      }
      await assertFinalSchema(client);
    });
    await withSchema('greenfield_reset_required', assertGreenfieldResetRequired);
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
