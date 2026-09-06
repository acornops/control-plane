import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { db } from '../src/infra/db.js';
import * as repository from '../src/store/repository-admin.js';
const enabled = Boolean(process.env.CONTROL_PLANE_TEST_DATABASE_URL);
const mutate = (input: any) => (repository as any).mutateWorkspacePolicy(input);
const audit = { adminTokenId: 'policy-test', action: 'admin.workspace.suspend', outcome: 'success', requestId: 'transport' };
async function fixture() {
 const id = `policy-${randomUUID()}`;
 await db.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'Policy Test')", [id, `${id}@example.test`]);
 await db.query("INSERT INTO workspaces (id,name,plan_key,created_by) VALUES ($1,'Policy Test','default',$1)", [id]);
 return id;
}
after(async () => { if (enabled) await db.query("DELETE FROM workspaces WHERE id LIKE 'policy-%'"); await db.end(); });
test('transactional policy operation exists', () => assert.equal(typeof (repository as any).mutateWorkspacePolicy, 'function'));
test('holds compose, retain onset, replay receipts and reject stale/no-op conflicts', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const body = { workspaceName: 'Policy Test', reason: 'Private case notes', source: 'admin', requestId: randomUUID(), expectedPolicyVersion: 0 };
 const first = await mutate({ workspaceId, operation: 'suspend', body, audit });
 assert.equal(first.after.policyVersion, 1);
 const second = await mutate({ workspaceId, operation: 'suspend', body: { ...body, source: 'external', requestId: randomUUID(), expectedPolicyVersion: 1 }, audit });
 assert.equal(second.after.suspendedAt, first.after.suspendedAt);
 assert.deepEqual(await mutate({ workspaceId, operation: 'suspend', body, audit }), first);
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body: { ...body, reason: 'different' }, audit }), { code: 'IDEMPOTENCY_CONFLICT' });
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body: { ...body, requestId: randomUUID() }, audit }), { code: 'WORKSPACE_POLICY_VERSION_CONFLICT' });
 const third = await mutate({ workspaceId, operation: 'restore', body: { ...body, expectedPolicyVersion: 2, requestId: randomUUID() }, audit });
 assert.equal(third.after.lifecycleStatus, 'suspended');
 assert.equal(third.after.suspendedAt, first.after.suspendedAt);
 const fourth = await mutate({ workspaceId, operation: 'restore', body: { ...body, source: 'external', expectedPolicyVersion: 3, requestId: randomUUID() }, audit });
 assert.equal(fourth.after.lifecycleStatus, 'active');
 assert.equal(fourth.after.policyVersion, 4);
 const rows = await db.query('SELECT count(*)::int AS count FROM admin_audit_events WHERE workspace_id=$1 AND outcome=\'success\'', [workspaceId]);
 assert.equal(rows.rows[0].count, 4);
});
test('audit failure rolls back policy and receipt', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body: { workspaceName: 'Policy Test', reason: 'test', requestId: randomUUID(), expectedPolicyVersion: 0 }, audit: { ...audit, action: null } }));
 const row = (await db.query('SELECT lifecycle_status,policy_version FROM workspaces WHERE id=$1', [workspaceId])).rows[0];
 assert.equal(row.lifecycle_status, 'active'); assert.equal(Number(row.policy_version), 0);
 assert.equal((await db.query('SELECT * FROM workspace_policy_receipts WHERE workspace_id=$1', [workspaceId])).rowCount, 0);
});
test('policy mutation enforces limits, preserves overrides and checks no-op versions', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 await db.query('INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$1,\'owner\')', [workspaceId]);
 await db.query('INSERT INTO workspace_quota_overrides (workspace_id,members) VALUES ($1,9)', [workspaceId]);
 const base = { reason: 'policy adjustment', requestId: randomUUID(), expectedPolicyVersion: 0 };
 const unchanged = await mutate({ workspaceId, operation: 'plan', body: { ...base, planKey: 'default' }, audit });
 assert.equal(unchanged.after.policyVersion, 0); assert.equal(unchanged.after.quotaOverrides.members, 9);
 await assert.rejects(mutate({ workspaceId, operation: 'plan', body: { ...base, requestId: randomUUID(), expectedPolicyVersion: 1, planKey: 'default' }, audit }), { code: 'WORKSPACE_POLICY_VERSION_CONFLICT' });
 await assert.rejects(mutate({ workspaceId, operation: 'plan', body: { ...base, requestId: randomUUID(), planKey: 'missing' }, audit }), { code: 'WORKSPACE_PLAN_NOT_CONFIGURED' });
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body: { ...base, requestId: randomUUID(), workspaceName: ' Policy Test ' }, audit }), { code: 'VALIDATION_ERROR' });
});
test('tenant policy audit contains only public reasons and is not duplicated by replay', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const input = { workspaceId, operation: 'suspend', body: { workspaceName: 'Policy Test', reason: 'confidential-note', publicReason: 'Contact support', requestId: randomUUID(), expectedPolicyVersion: 0 }, audit };
 await mutate(input); await mutate(input);
 const events = (await db.query('SELECT metadata FROM workspace_audit_events WHERE workspace_id=$1', [workspaceId])).rows;
 assert.equal(events.length, 1); assert.equal(events[0].metadata.publicReason, 'Contact support');
 assert.equal(JSON.stringify(events).includes('confidential-note'), false);
});
test('downgrades reject excess by default and retain_existing preserves admitted resources', { skip: !enabled }, async () => {
 const { config } = await import('../src/config.js');
 const workspaceId = await fixture();
 const other = `${workspaceId}-member`;
 await db.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'Other')", [other, `${other}@example.test`]);
 await db.query("INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$1,'owner'),($1,$2,'viewer')", [workspaceId, other]);
 config.WORKSPACE_PLANS.plans.push({ key: 'policy-small', name: 'Small', quotas: { members: 1, kubernetesClusters: 1, virtualMachines: 1 } });
 try {
  const body = { planKey: 'policy-small', reason: 'downgrade', requestId: randomUUID(), expectedPolicyVersion: 0 };
  await assert.rejects(mutate({ workspaceId, operation: 'plan', body, audit }), { code: 'VALIDATION_ERROR' });
  assert.equal((await db.query('SELECT policy_version FROM workspaces WHERE id=$1', [workspaceId])).rows[0].policy_version, '0');
  const result = await mutate({ workspaceId, operation: 'plan', body: { ...body, overLimitBehavior: 'retain_existing' }, audit });
  assert.equal(result.after.plan.key, 'policy-small'); assert.equal(result.after.memberCount, 2); assert.equal(result.overLimit.members, true);
 } finally { await db.query("UPDATE workspaces SET plan_key='default' WHERE id=$1", [workspaceId]); config.WORKSPACE_PLANS.plans.pop(); }
});
test('concurrent requests serialize policy versions and duplicate receipts', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const body = { workspaceName: 'Policy Test', reason: 'parallel', requestId: randomUUID(), expectedPolicyVersion: 0 };
 const input = { workspaceId, operation: 'suspend', body, audit };
 const repeated = await Promise.all([mutate(input), mutate(input)]);
 assert.deepEqual(repeated[0], repeated[1]);
 const results = await Promise.allSettled(['admin', 'external'].map(source => mutate({ workspaceId, operation: 'restore', body: { ...body, source, expectedPolicyVersion: 1, requestId: randomUUID() }, audit })));
 // The missing external hold is a no-op; either order is valid, with at most one version advance.
 assert.equal((await db.query('SELECT policy_version FROM workspaces WHERE id=$1', [workspaceId])).rows[0].policy_version, '2');
 assert.ok(results.some(result => result.status === 'fulfilled'));
});
test('catalogue preflight rejects missing assignments and mutated limits but permits display-name changes', { skip: !enabled }, async () => {
 const { preflightWorkspacePlanCatalog } = await import('../src/store/repository-workspace-policy-read.js');
 const { config } = await import('../src/config.js');
 const workspaceId = await fixture();
 await db.query("UPDATE workspaces SET plan_key='missing-plan' WHERE id=$1", [workspaceId]);
 await assert.rejects(preflightWorkspacePlanCatalog(), { code: 'WORKSPACE_PLAN_NOT_CONFIGURED' });
 await db.query("UPDATE workspaces SET plan_key='default' WHERE id=$1", [workspaceId]);
 await preflightWorkspacePlanCatalog();
 const plan = config.WORKSPACE_PLANS.plans.find(plan => plan.key === 'default')!;
 const originalName = plan.name, members = plan.quotas.members;
 try {
  plan.name = 'Renamed'; await preflightWorkspacePlanCatalog();
  plan.quotas.members += 1;
  await assert.rejects(preflightWorkspacePlanCatalog(), /immutable key/);
 } finally { plan.name = originalName; plan.quotas.members = members; }
});
test('execution usage includes unsettled parked and executing reservations across pools', { skip: !enabled }, async () => {
 const { getWorkspacePolicy } = await import('../src/store/repository-workspace-policy-read.js');
 const workspaceId = await fixture();
 await db.query(`INSERT INTO workspace_run_reservations (run_id,workspace_id,pool,state,executing_until,queue_expires_at,settled_at) VALUES
 ($1,$4,'chat','executing',NOW()+INTERVAL '1 minute',NOW()+INTERVAL '1 hour',NULL),
 ($2,$4,'chat','parked',NULL,NOW()+INTERVAL '1 hour',NULL),
 ($3,$4,'agent','settled',NULL,NOW()+INTERVAL '1 hour',NOW())`, [randomUUID(), randomUUID(), randomUUID(), workspaceId]);
 const snapshot = await getWorkspacePolicy(workspaceId);
 assert.deepEqual(snapshot.usage.execution.chat, { concurrentRuns: 1, outstandingRuns: 2 });
 assert.deepEqual(snapshot.usage.execution.agent, { concurrentRuns: 0, outstandingRuns: 0 });
 assert.equal(Object.keys(snapshot.usage.execution).length, 5);
});
test('receipts are isolated by credential and operation', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const requestId = randomUUID();
 const body = { workspaceName: 'Policy Test', reason: 'scope receipts', requestId, expectedPolicyVersion: 0 };
 await mutate({ workspaceId, operation: 'suspend', body, audit });
 const otherToken = { ...audit, adminTokenId: 'policy-other' };
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body, audit: otherToken }), { code: 'WORKSPACE_POLICY_VERSION_CONFLICT' });
 const restored = await mutate({ workspaceId, operation: 'restore', body: { ...body, expectedPolicyVersion: 1 }, audit });
 assert.equal(restored.after.lifecycleStatus, 'active');
 assert.equal((await db.query('SELECT * FROM workspace_policy_receipts WHERE workspace_id=$1', [workspaceId])).rowCount, 2);
});
test('successful and rejected mutations retain useful protected audit facts', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const body = { workspaceName: 'Policy Test', reason: 'Private audit note', publicReason: 'Contact support', requestId: randomUUID(), expectedPolicyVersion: 0 };
 await mutate({ workspaceId, operation: 'suspend', body, audit });
 await assert.rejects(mutate({ workspaceId, operation: 'restore', body: { ...body, requestId: randomUUID() }, audit }), { code: 'WORKSPACE_POLICY_VERSION_CONFLICT' });
 const rows = (await db.query('SELECT outcome,metadata FROM admin_audit_events WHERE workspace_id=$1 ORDER BY occurred_at', [workspaceId])).rows;
 assert.equal(rows.length, 2);
 assert.equal(rows[0].metadata.before.lifecycleStatus, 'active');
 assert.equal(rows[0].metadata.after.lifecycleStatus, 'suspended');
 assert.equal(rows[1].outcome, 'failure');
 assert.equal(rows[1].metadata.errorCode, 'WORKSPACE_POLICY_VERSION_CONFLICT');
});
test('suspension policy resolves a generic administrator reason for migrated null holds', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 await db.query("INSERT INTO workspace_suspension_holds (workspace_id,source) VALUES ($1,'admin')", [workspaceId]);
 await db.query("UPDATE workspaces SET lifecycle_status='suspended',suspended_at=NOW() WHERE id=$1", [workspaceId]);
 const { getWorkspacePolicy } = await import('../src/store/repository-workspace-policy-read.js');
 const policy = await getWorkspacePolicy(workspaceId);
 assert.equal(typeof (policy as any).publicReason, 'string');
 assert.ok((policy as any).publicReason.length > 0);
});
test('receipt cleanup removes only receipts older than thirty days', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 await mutate({ workspaceId, operation: 'plan', body: { planKey: 'default', reason: 'old receipt', requestId: 'old', expectedPolicyVersion: 0 }, audit });
 await mutate({ workspaceId, operation: 'plan', body: { planKey: 'default', reason: 'fresh receipt', requestId: 'fresh', expectedPolicyVersion: 0 }, audit });
 await db.query("UPDATE workspace_policy_receipts SET created_at=NOW()-INTERVAL '31 days' WHERE workspace_id=$1 AND request_id='old'", [workspaceId]);
 const repository = await import('../src/store/repository-workspace-policy-read.js');
 assert.equal(typeof (repository as any).cleanupWorkspacePolicyReceipts, 'function');
 await (repository as any).cleanupWorkspacePolicyReceipts();
 assert.deepEqual((await db.query('SELECT request_id FROM workspace_policy_receipts WHERE workspace_id=$1', [workspaceId])).rows, [{ request_id: 'fresh' }]);
});
test('expired receipts cannot bypass the expected version and inherited plan keys are rejected', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const body = { workspaceName: 'Policy Test', reason: 'expire replay', requestId: randomUUID(), expectedPolicyVersion: 0 };
 await mutate({ workspaceId, operation: 'suspend', body, audit });
 await db.query("UPDATE workspace_policy_receipts SET created_at=NOW()-INTERVAL '31 days' WHERE workspace_id=$1", [workspaceId]);
 await assert.rejects(mutate({ workspaceId, operation: 'suspend', body, audit }), { code: 'WORKSPACE_POLICY_VERSION_CONFLICT' });
 await assert.rejects(mutate({ workspaceId, operation: 'plan', body: { planKey: 'constructor', reason: 'unknown plan', expectedPolicyVersion: 1 }, audit }), { code: 'WORKSPACE_PLAN_NOT_CONFIGURED' });
});
test('additive migration preserves and namespaces legacy receipts and suspension onset', { skip: !enabled }, async () => {
 const { readFile } = await import('node:fs/promises');
 const client = await db.connect();
 const schema = `policy_migration_${randomUUID().replaceAll('-', '')}`;
 try {
  await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET LOCAL search_path TO ${schema}, public`);
  const files = ['001_initial_schema.sql','002_target_permission_mode.sql','003_help_links_platform_setting.sql','004_agentv_enrollment_credentials.sql','005_agentv_enrollment_access_policy.sql','006_mcp_user_lifecycle.sql'];
  for (const file of files) await client.query(await readFile(new URL(`../migrations/control-plane/${file}`, import.meta.url), 'utf8'));
  await client.query("INSERT INTO users (id,email,display_name) VALUES ('legacy-user','legacy@example.test','Legacy')");
  await client.query("INSERT INTO workspaces (id,name,created_by,lifecycle_status,suspended_at) VALUES ('legacy-workspace','Legacy','legacy-user','suspended','2026-01-01T00:00:00Z')");
  await client.query(await readFile(new URL('../migrations/control-plane/007_workspace_policy.sql', import.meta.url), 'utf8'));
  await client.query("INSERT INTO workspace_policy_receipts (workspace_id,request_id,body_hash,response) VALUES ('legacy-workspace','matched',repeat('a',64),'{}'),('legacy-workspace','orphan',repeat('b',64),'{}')");
  await client.query(`INSERT INTO admin_audit_events (id,admin_token_id,action,outcome,request_id,workspace_id,metadata) VALUES ('legacy-audit','legacy-token','admin.workspace.suspend','success','transport','legacy-workspace','{"policyRequestId":"matched"}')`);
  await client.query(await readFile(new URL('../migrations/control-plane/010_workspace_policy_receipt_identity.sql', import.meta.url), 'utf8'));
  const holds = (await client.query('SELECT public_reason,created_at FROM workspace_suspension_holds')).rows;
  assert.equal(holds[0].created_at.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(holds[0].public_reason, 'Workspace access is temporarily suspended by an administrator.');
  assert.deepEqual((await client.query('SELECT request_id,admin_token_id,operation FROM workspace_policy_receipts ORDER BY request_id')).rows, [
   { request_id: 'matched', admin_token_id: 'legacy-token', operation: 'suspend' },
   { request_id: 'orphan', admin_token_id: '__legacy_unattributed__', operation: 'plan' }
  ]);
 } finally { await client.query('ROLLBACK'); client.release(); }
});
test('execution-limit downgrade checks admitted runs and writes rejection audit', { skip: !enabled }, async () => {
 const { config } = await import('../src/config.js');
 const { resolveExecutionLimits } = await import('../src/types/workspace-policy.js');
 const workspaceId = await fixture();
 const planKey = 'policy-execution-small';
 config.WORKSPACE_PLANS.plans.push({ key: planKey, name: 'Small', quotas: { members: 100, kubernetesClusters: 30, virtualMachines: 30 }, executionLimits: resolveExecutionLimits({ chat: { maxConcurrentRuns: 1, maxOutstandingRuns: 1 } }) });
 try {
  await db.query("INSERT INTO workspace_run_reservations (run_id,workspace_id,pool,queue_expires_at) VALUES ($1,$3,'chat',NOW()+INTERVAL '1 hour'),($2,$3,'chat',NOW()+INTERVAL '1 hour')", [randomUUID(), randomUUID(), workspaceId]);
  const body = { planKey, reason: 'reduce execution quota', requestId: randomUUID(), expectedPolicyVersion: 0 };
  await assert.rejects(mutate({ workspaceId, operation: 'plan', body, audit }), { code: 'VALIDATION_ERROR' });
  assert.equal((await db.query("SELECT count(*)::int AS count FROM admin_audit_events WHERE workspace_id=$1 AND outcome='failure'", [workspaceId])).rows[0].count, 1);
  const retained = await mutate({ workspaceId, operation: 'plan', body: { ...body, overLimitBehavior: 'retain_existing' }, audit });
  assert.equal(retained.policy.usage.execution.chat.outstandingRuns, 2);
  assert.equal(retained.after.plan.key, planKey);
 } finally { await db.query("UPDATE workspaces SET plan_key='default' WHERE id=$1", [workspaceId]); config.WORKSPACE_PLANS.plans.pop(); }
});
test('an expired versionless restore receipt cannot clear a newer suspension hold', { skip: !enabled }, async () => {
 const workspaceId = await fixture();
 const requestId = randomUUID();
 // Model a receipt produced before the version requirement was introduced.
 await db.query(`INSERT INTO workspace_policy_receipts (workspace_id,request_id,body_hash,response,admin_token_id,operation,created_at)
 VALUES ($1,$2,repeat('a',64),'{}',$3,'restore',NOW()-INTERVAL '31 days')`, [workspaceId, requestId, audit.adminTokenId]);
 await mutate({ workspaceId, operation: 'suspend', body: { workspaceName: 'Policy Test', reason: 'new hold' }, audit });
 await assert.rejects(mutate({ workspaceId, operation: 'restore', body: { requestId, reason: 'old restore' }, audit }), { code: 'POLICY_PRECONDITION_REQUIRED' });
 const row = (await db.query('SELECT lifecycle_status,policy_version FROM workspaces WHERE id=$1', [workspaceId])).rows[0];
 assert.equal(row.lifecycle_status, 'suspended'); assert.equal(row.policy_version, '1');
 const legacy = await mutate({ workspaceId, operation: 'restore', body: { reason: 'intentional legacy restore' }, audit });
 assert.equal(legacy.after.lifecycleStatus, 'active');
});
